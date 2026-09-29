"use strict";

/**
 * Historical sample migration.
 *
 * On the contract-evolution page the user pastes up to MAX_SAMPLES old
 * samples and configures mappings of the form
 *
 *   { "from": "/old/path", "to": "/new/path", "default"?: <any> }
 *
 * where both pointers are RFC 6901 JSON Pointers into a sample. For every
 * mapping the value at `from` is MOVED to `to` (the source location is
 * removed); when the source is missing, an optional `default` fills the
 * target instead (a missing source without a default is simply skipped).
 *
 * Operations are planned once, ordered by path depth BEFORE any sample is
 * touched:
 *
 *   - source removals run deepest first (so a descendant move happens before
 *     its ancestor subtree is removed); numeric array siblings of the same
 *     depth come off from the highest index down — a deterministic, readable
 *     plan only, since removals leave tombstone holes (see below) and never
 *     shift the indexes of upcoming operations;
 *   - target writes run shallowest first, so parent containers exist before
 *     their children are written.
 *
 * Per sample the plan executes atomically:
 *
 *   - every present source is extracted (deep-cloned) into an operation list
 *     before any target is written, which makes swaps (/a -> /b, /b -> /a)
 *     and chains (/a -> /b, /b -> /c) work;
 *   - array indexes at EVERY level address the pre-migration element
 *     positions: removing a source from an array leaves a tombstone hole
 *     instead of splicing, so later removals and all target writes still
 *     resolve to the original slots — swapping /arr/0 and /arr/1 of
 *     ["A","B","C"] yields ["B","A","C"], the untouched C is never lost,
 *     and the mapping order cannot change these outcomes;
 *   - once ALL target writes are done, the holes left over in arrays are
 *     compacted away in a single recursive pass (holes carried inside a
 *     moved subtree included); a hole a target write refilled is ordinary
 *     data again and stays put;
 *   - a pre-existing target that is not removed by an active source move
 *     (the target itself or an ancestor of it was an extracted source) is a
 *     conflict, and so are two operations ending up at the same concrete
 *     path, an out-of-range array index, a non-index key on an array and a
 *     write whose path runs through an existing (or just-written) scalar;
 *   - missing intermediate containers are auto-created: an array when the
 *     next segment is a canonical array index or the "-" append marker, an
 *     object otherwise;
 *   - ANY conflict rolls the whole sample back: it stays byte-for-byte equal
 *     to the input and the reasons are reported, status "conflict".
 *
 * Every non-conflicting result is then validated with Ajv against the
 * CURRENT schema; results group into success (applied + valid), conflict
 * (kept as-is) and invalid (applied but validation failed). When the
 * baseline schema is supplied, the ORIGINAL sample is also validated
 * against it, so the UI can show whether the migration healed it.
 *
 * Shape violations are 400; an uncompilable schema or a semantically invalid
 * mapping set (illegal pointer, root target, identical source/target,
 * duplicate sources) refuses the whole run with 422 and per-mapping reasons.
 */

const Ajv2020 = require("ajv/dist/2020").default;
const { parsePointer } = require("./variant");
const { escapePointer, setOwnKey } = require("./infer");

const MAX_SAMPLES = 200;

const POINTER_HINT =
  'JSON Pointer 须以 "/" 开头（源路径可用空串 "" 表示样本根），"~" 仅允许写作 ~0（表示 ~）或 ~1（表示 /）；末段 "-" 仅可用于目标路径，表示数组末尾追加';

// RFC 6901 array index: "0" or digits without a leading zero.
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

const MISSING = Symbol("missing");
const UNSET = Symbol("unset");
// Tombstone left behind when a source is extracted from an array: the slot
// keeps its pre-migration index (no splice, no shifting) until compactHoles
// reclaims the still-empty holes after every target write completed.
const HOLE = Symbol("hole");

const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });

const clone = (value) => JSON.parse(JSON.stringify(value));

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Canonical string form of parsed segments ("" for the root). */
function displayPointer(segments) {
  return segments.length === 0 ? "" : `/${segments.map(escapePointer).join("/")}`;
}

function samePath(a, b) {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/** True when `prefix` equals `path` or is a strict ancestor of it. */
function pathCovers(prefix, path) {
  return prefix.length <= path.length && prefix.every((segment, i) => segment === path[i]);
}

/** Read at parsed segments; MISSING for absent keys, bad indexes and scalars. */
function locate(node, segments) {
  for (const segment of segments) {
    if (node === null || typeof node !== "object") return MISSING;
    if (Array.isArray(node)) {
      if (!ARRAY_INDEX.test(segment)) return MISSING;
      const index = Number(segment);
      if (index >= node.length) return MISSING;
      node = node[index];
    } else if (!Object.prototype.hasOwnProperty.call(node, segment)) {
      return MISSING;
    } else {
      node = node[segment];
    }
  }
  return node;
}

/**
 * Remove and return the value at parsed segments. The caller already checked
 * the location resolves. Array elements are replaced with a HOLE tombstone
 * (NOT spliced out), so every later removal and every target write keeps
 * resolving array indexes against the pre-migration element positions;
 * compactHoles reclaims the leftover holes once all writes are done.
 */
function extract(root, segments) {
  if (segments.length === 0) return { root: UNSET, value: root };
  let node = root;
  for (let i = 0; i < segments.length - 1; i += 1) node = node[segments[i]];
  const last = segments[segments.length - 1];
  let value;
  if (Array.isArray(node)) {
    const index = Number(last);
    value = node[index];
    node[index] = HOLE;
  } else {
    value = node[last];
    delete node[last];
  }
  return { root, value };
}

/**
 * Reclaim the HOLE tombstones source removals left in arrays, recursively.
 * Runs once per sample AFTER every target write completed: a hole a write
 * refilled is ordinary data again and survives; only still-empty slots drop
 * out, shifting the survivors left to close the gaps. Holes carried inside
 * a moved subtree (an inner source was extracted before its ancestor array
 * moved) are compacted as well.
 */
function compactHoles(node) {
  if (Array.isArray(node)) {
    let write = 0;
    for (let read = 0; read < node.length; read += 1) {
      const item = node[read];
      if (item === HOLE) continue;
      compactHoles(item);
      node[write] = item;
      write += 1;
    }
    node.length = write;
    return;
  }
  if (isPlainObject(node)) {
    for (const key of Object.keys(node)) compactHoles(node[key]);
  }
}

/**
 * Write `value` at parsed segments, auto-creating missing intermediate
 * containers (array for a canonical-index / "-" child, object otherwise).
 * Array indexes address pre-migration element positions: a HOLE tombstone
 * counts as an empty slot — writing over it (or through it) refills the
 * hole, which then survives the final compaction. Returns an error reason
 * string or null on success. Mutates `holder.root`, including (re)creating
 * the root after a whole-root source move.
 *
 * `written` maps concrete path strings to the mapping index that placed them;
 * it turns a second write to the same location into a conflict (two "-"
 * appends still resolve to different indexes and therefore coexist).
 */
function applyWrite(holder, segments, mappingIndex, value, written) {
  if (holder.root === UNSET) {
    holder.root = makeContainerFor(segments[0]);
  }
  let node = holder.root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];
    if (Array.isArray(node)) {
      if (!ARRAY_INDEX.test(segment)) {
        return `目标路径 ${displayPointer(segments.slice(0, i + 1))} 位于数组，仅可使用数字下标`;
      }
      const index = Number(segment);
      if (index > node.length) {
        return `目标路径中途数组下标 ${index} 越界（当前长度 ${node.length}）`;
      }
      if (index === node.length) {
        // Auto-append exactly one element when the chain runs into a
        // freshly created array (index == length); gaps stay a conflict.
        const appended = makeContainerFor(nextSegment);
        node.push(appended);
      }
      let child = node[index];
      if (child === HOLE) {
        // A source move emptied this slot; the write refills it with a fresh
        // container, and the refilled slot survives the final compaction.
        child = makeContainerFor(nextSegment);
        node[index] = child;
      }
      if (child === null || typeof child !== "object") {
        return `目标路径中途 ${displayPointer(segments.slice(0, i + 1))} 为标量，无法继续向下写入`;
      }
      node = child;
      continue;
    }
    if (node === null || typeof node !== "object") {
      return `目标路径中途 ${displayPointer(segments.slice(0, i + 1))} 为标量，无法继续向下写入`;
    }
    if (!Object.prototype.hasOwnProperty.call(node, segment)) {
      setOwnKey(node, segment, makeContainerFor(nextSegment));
    }
    const child = node[segment];
    if (child === null || typeof child !== "object") {
      return `目标路径中途 ${displayPointer(segments.slice(0, i + 1))} 为标量，无法继续向下写入`;
    }
    node = child;
  }

  const last = segments[segments.length - 1];
  let concrete;
  if (Array.isArray(node)) {
    if (last === "-") {
      node.push(value);
      concrete = [...segments.slice(0, -1), String(node.length - 1)];
    } else if (ARRAY_INDEX.test(last)) {
      const index = Number(last);
      if (index > node.length) {
        return `目标数组下标 ${index} 越界（当前长度 ${node.length}，仅允许替换已有元素或在末尾追加）`;
      }
      concrete = segments;
      if (index === node.length) node.push(value);
      else node[index] = value;
    } else {
      return `目标路径 ${displayPointer(segments)} 位于数组，"${last}" 不是合法数字下标`;
    }
  } else if (node === null || typeof node !== "object") {
    return `目标路径中途 ${displayPointer(segments.slice(0, -1)) || "(root)"} 为标量，无法继续向下写入`;
  } else {
    concrete = segments;
    setOwnKey(node, last, value);
  }

  // Length-prefixed per-segment key, so a literal "a/b" key can never collide
  // with the two-segment path ["a", "b"].
  const key = concrete.map((segment) => `${segment.length}:${segment}`).join("/");
  if (written.has(key)) {
    return `目标路径 ${displayPointer(concrete)} 与映射 ${written.get(key) + 1} 的写入位置冲突`;
  }
  written.set(key, mappingIndex);
  return null;
}

/** Container kind implied by the child segment about to be placed inside. */
function makeContainerFor(childSegment) {
  return ARRAY_INDEX.test(childSegment) || childSegment === "-" ? [] : {};
}

function mapErrors(validate) {
  return (validate.errors || []).map((e) => ({
    path: e.instancePath || "",
    pointer: e.instancePath || "(root)",
    schemaPath: e.schemaPath,
    keyword: e.keyword,
    message: e.message,
    params: e.params,
  }));
}

/**
 * Validate the mapping configuration itself (independent of any sample).
 * Returns per-mapping problems; an empty list means the plan is usable.
 */
function planMappings(mappings) {
  const invalid = [];
  const parsed = mappings.map((mapping, index) => {
    const entry = { index, from: mapping.from, to: mapping.to, fromSegs: null, toSegs: null };
    const fromSegs = parsePointer(mapping.from);
    const toSegs = parsePointer(mapping.to);
    if (fromSegs === null) {
      invalid.push({ index, from: mapping.from, to: mapping.to, reason: `源 Pointer 非法。${POINTER_HINT}` });
      return entry;
    }
    if (toSegs === null) {
      invalid.push({ index, from: mapping.from, to: mapping.to, reason: `目标 Pointer 非法。${POINTER_HINT}` });
      return entry;
    }
    entry.fromSegs = fromSegs;
    entry.toSegs = toSegs;
    if (toSegs.length === 0) {
      invalid.push({ index, from: mapping.from, to: mapping.to, reason: '目标路径不能为样本根（""），请指定具体字段' });
    }
    // "-" only makes sense as the last target segment (array append).
    if (toSegs.slice(0, -1).includes("-")) {
      invalid.push({
        index,
        from: mapping.from,
        to: mapping.to,
        reason: '目标路径中的 "-" 只能作为末段，表示数组末尾追加',
      });
    }
    if (samePath(fromSegs, toSegs)) {
      invalid.push({
        index,
        from: mapping.from,
        to: mapping.to,
        reason: `源路径与目标路径相同（${mapping.from || "(root)"}），该映射无需迁移`,
      });
    }
    return entry;
  });

  // Duplicate sources cannot be planned: two moves would fight over one value.
  for (let i = 0; i < parsed.length; i += 1) {
    const a = parsed[i];
    if (!a.fromSegs || invalid.some((p) => p.index === i)) continue;
    for (let j = 0; j < i; j += 1) {
      const b = parsed[j];
      if (!b.fromSegs || invalid.some((p) => p.index === j)) continue;
      if (samePath(a.fromSegs, b.fromSegs)) {
        invalid.push({
          index: i,
          from: a.from,
          to: a.to,
          reason: `源路径 ${a.from || "(root)"} 与第 ${j + 1} 条映射重复，同一路径只能迁移一次`,
        });
      }
    }
  }

  // Target parent/child overlap is ambiguous (one mapping overwrites the
  // subtree another mapping writes into) and cannot be planned; report the
  // later mapping. Exact duplicate targets stay a per-sample conflict, since
  // they are fine whenever the earlier target was written by an active move.
  for (let i = 0; i < parsed.length; i += 1) {
    const a = parsed[i];
    if (!a.toSegs || invalid.some((p) => p.index === i)) continue;
    for (let j = 0; j < i; j += 1) {
      const b = parsed[j];
      if (!b.toSegs || invalid.some((p) => p.index === j)) continue;
      if (
        (b.toSegs.length < a.toSegs.length && pathCovers(b.toSegs, a.toSegs)) ||
        (a.toSegs.length < b.toSegs.length && pathCovers(a.toSegs, b.toSegs))
      ) {
        invalid.push({
          index: i,
          from: a.from,
          to: a.to,
          reason: `目标路径 ${a.to} 与第 ${j + 1} 条映射的目标路径 ${b.to} 构成父子重叠（一个映射会覆盖另一个写入的子树），请改为并列路径`,
        });
        break;
      }
    }
  }

  return { invalid, parsed };
}

/**
 * Plan the global operation order (independent of any concrete sample).
 *
 * Source removals: deepest first (a descendant comes off before its ancestor
 * subtree moves); numeric array siblings of the same parent are listed from
 * the highest index down. The index ordering is cosmetic — removals leave
 * HOLE tombstones instead of splicing, so indexes never shift under an
 * upcoming removal either way. Target writes: shallowest first, ties keeping
 * the configured order.
 */
function buildOperationOrder(parsed) {
  const indices = parsed.map((_, index) => index);
  const sourceOrder = [...indices].sort((i, j) => {
    const a = parsed[i].fromSegs;
    const b = parsed[j].fromSegs;
    if (a.length !== b.length) return b.length - a.length; // deeper first
    const sameParent =
      a.length > 0 &&
      a.slice(0, -1).every((segment, k) => segment === b[k]);
    const ai = ARRAY_INDEX.test(a[a.length - 1]) ? Number(a[a.length - 1]) : null;
    const bi = ARRAY_INDEX.test(b[b.length - 1]) ? Number(b[b.length - 1]) : null;
    if (sameParent && ai !== null && bi !== null && ai !== bi) return bi - ai;
    return i - j; // stable
  });
  const targetOrder = [...indices].sort((i, j) => {
    const a = parsed[i].toSegs.length;
    const b = parsed[j].toSegs.length;
    return a !== b ? a - b : i - j;
  });
  return { sourceOrder, targetOrder };
}

/**
 * Run the migration for every sample and classify the results.
 *
 * @returns {{ total: number,
 *            summary: { success: number, conflict: number, invalid: number },
 *            plan: { sourceRemovals: Array<{ mapping: number, pointer: string }>,
 *                    targetWrites: Array<{ mapping: number, pointer: string }> },
 *            mappings: Array<{ index: number, from: string, to: string,
 *                              hasDefault: boolean }>,
 *            samples: Array<object> }}
 */
function migrateSamples({ baselineSchema, currentSchema, samples, mappings }) {
  if (!isPlainObject(currentSchema)) {
    throw Object.assign(new Error("Request body must contain a 'currentSchema' object."), {
      status: 400,
    });
  }
  if (baselineSchema !== undefined && baselineSchema !== null && !isPlainObject(baselineSchema)) {
    throw Object.assign(new Error("'baselineSchema' must be an object when provided."), {
      status: 400,
    });
  }
  if (!Array.isArray(samples) || samples.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'samples' array."), {
      status: 400,
    });
  }
  if (samples.length > MAX_SAMPLES) {
    throw Object.assign(
      new Error(
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per migration.`
      ),
      { status: 400 }
    );
  }
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'mappings' array."), {
      status: 400,
    });
  }
  for (const mapping of mappings) {
    if (!isPlainObject(mapping) || typeof mapping.from !== "string" || typeof mapping.to !== "string") {
      throw Object.assign(
        new Error("Every mapping must be an object with string 'from' and 'to' pointers."),
        { status: 400 }
      );
    }
  }

  let validateCurrent;
  let validateBaseline = null;
  try {
    validateCurrent = ajv.compile(currentSchema);
    if (baselineSchema) validateBaseline = ajv.compile(baselineSchema);
  } catch (err) {
    throw Object.assign(new Error(`Invalid schema: ${err.message}`), { status: 422 });
  }

  const { invalid, parsed } = planMappings(mappings);
  if (invalid.length > 0) {
    const shown = invalid
      .slice(0, 10)
      .map((p) => `第 ${p.index + 1} 条映射（${p.from || "(root)"} → ${p.to}）：${p.reason}`)
      .join("；");
    throw Object.assign(new Error(`${shown}。未执行迁移。`), {
      status: 422,
      details: { invalidMappings: invalid },
    });
  }

  const { sourceOrder, targetOrder } = buildOperationOrder(parsed);
  const plan = {
    sourceRemovals: sourceOrder.map((index) => ({
      mapping: index,
      pointer: mappings[index].from,
    })),
    targetWrites: targetOrder.map((index) => ({ mapping: index, pointer: mappings[index].to })),
  };
  const mappingInfo = mappings.map((mapping, index) => ({
    index,
    from: mapping.from,
    to: mapping.to,
    hasDefault: Object.prototype.hasOwnProperty.call(mapping, "default"),
  }));

  const summary = { success: 0, conflict: 0, invalid: 0 };
  const results = samples.map((sample, sampleIndex) => {
    const original = sample;
    const holder = { root: clone(sample) };
    const operations = [];
    const reasons = [];
    // Sources that were actually extracted from THIS sample; a pre-existing
    // target is acceptable only when an extracted source removes it.
    const activeSources = [];

    // Phase A: extract every present source, deepest first.
    for (const mappingIndex of sourceOrder) {
      const { fromSegs, toSegs } = parsed[mappingIndex];
      const found = locate(holder.root, fromSegs);
      if (found !== MISSING) {
        const extracted = extract(holder.root, fromSegs);
        holder.root = extracted.root;
        activeSources.push(fromSegs);
        operations.push({
          kind: "move",
          mapping: mappingIndex,
          from: mappings[mappingIndex].from,
          to: mappings[mappingIndex].to,
        });
        // Park the value on the operation; phase B consumes it in write order.
        operations[operations.length - 1].value = extracted.value;
      } else if (Object.prototype.hasOwnProperty.call(mappings[mappingIndex], "default")) {
        operations.push({
          kind: "default",
          mapping: mappingIndex,
          to: mappings[mappingIndex].to,
          value: clone(mappings[mappingIndex].default),
        });
      } else {
        operations.push({
          kind: "skip",
          mapping: mappingIndex,
          from: mappings[mappingIndex].from,
          to: mappings[mappingIndex].to,
          reason: "源路径在该样本中缺失，且未配置默认值",
        });
      }
    }

    // A pre-existing target is a conflict unless an active source move
    // removes exactly that location or one of its ancestors. Mappings whose
    // source is missing and carry no default do nothing, so they cannot
    // conflict with anything.
    const opByMapping = new Map(operations.map((op) => [op.mapping, op]));
    for (const mappingIndex of targetOrder) {
      const op = opByMapping.get(mappingIndex);
      if (!op || op.kind === "skip") continue;
      const toSegs = parsed[mappingIndex].toSegs;
      const existing = locate(original, toSegs);
      if (
        existing !== MISSING &&
        !activeSources.some((sourceSegs) => pathCovers(sourceSegs, toSegs))
      ) {
        reasons.push(
          `目标路径 ${mappings[mappingIndex].to} 已存在值，且没有生效的源移动覆盖该位置（拒绝覆盖）`
        );
      }
    }

    // Phase B: write shallowest first, auto-vivifying missing containers.
    const written = new Map(); // concrete path key -> mapping index
    if (reasons.length === 0) {
      for (const mappingIndex of targetOrder) {
        const op = opByMapping.get(mappingIndex);
        if (op.kind === "skip") continue;
        const error = applyWrite(holder, parsed[mappingIndex].toSegs, mappingIndex, op.value, written);
        if (error) {
          reasons.push(`映射 ${mappingIndex + 1}（${op.kind === "default" ? "默认值" : mappings[mappingIndex].from} → ${mappings[mappingIndex].to}）：${error}`);
          break;
        }
      }
    }

    // Phase C: only after EVERY target write completed, compact the holes
    // source removals left in arrays (recursively). Holes a write refilled
    // are kept; the rest drop out without disturbing the survivors' order.
    if (reasons.length === 0) {
      compactHoles(holder.root);
    }

    const baseline = validateBaseline
      ? (() => {
          const valid = validateBaseline(original);
          return { valid, errors: valid ? [] : mapErrors(validateBaseline) };
        })()
      : null;

    if (reasons.length > 0) {
      summary.conflict += 1;
      const valid = validateCurrent(original);
      return {
        index: sampleIndex,
        status: "conflict",
        before: original,
        after: null,
        reasons,
        operations: operations.map(stripValue),
        baseline,
        current: { valid, errors: valid ? [] : mapErrors(validateCurrent) },
      };
    }

    const migrated = holder.root;
    const currentValid = validateCurrent(migrated);
    const status = currentValid ? "success" : "invalid";
    summary[status] += 1;
    return {
      index: sampleIndex,
      status,
      before: original,
      after: migrated,
      reasons: [],
      operations: operations.map(stripValue),
      baseline,
      current: { valid: currentValid, errors: currentValid ? [] : mapErrors(validateCurrent) },
    };
  });

  return {
    total: samples.length,
    summary,
    plan,
    mappings: mappingInfo,
    samples: results,
  };
}

/** Operation rows go back to the client without the carried payload. */
function stripValue(op) {
  const { value, ...rest } = op;
  return rest;
}

module.exports = { migrateSamples, MAX_SAMPLES, POINTER_HINT };
