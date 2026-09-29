"use strict";

/**
 * Contract slicing.
 *
 * The user picks 1..MAX_POINTERS JSON Pointers into the current schema tree
 * ("" addresses the root; object properties are addressed via
 * "/properties/<key>" and array elements via "/items", exactly the pointers
 * the tree view displays). The backend produces a standalone slice schema
 * that keeps only the selected nodes plus the ancestor structure needed to
 * reach them, and projects every sample along the same paths:
 *
 *   - ancestor wins: when a selected pointer sits below another selected
 *     pointer it is ignored (reported in `ignored`), because the ancestor
 *     already keeps the whole subtree;
 *   - objects keep only the `properties` that lead to (or sit below) a
 *     selection; `required` keeps only fields that were required originally
 *     AND survived the slice;
 *   - arrays recurse along `items`;
 *   - `type` unions, `const` and every other non-structural keyword are
 *     carried over unchanged;
 *   - a fully selected subtree is kept (and projected) verbatim.
 *
 * Sample projection mirrors the slice: selected subtrees are cloned whole,
 * ancestor objects keep only the keys on a selection path, ancestor arrays
 * map every element through the `items` selection, and values whose shape
 * cannot follow the selection path (scalars, or arrays/objects where the
 * selection walks the other kind) are kept verbatim as chain terminals.
 *
 * Every projected sample is validated against the slice schema with Ajv; a
 * single failure refuses the whole run (422) and reports the offending
 * sample indexes together with the Ajv errors.
 *
 * A single run is capped at MAX_SAMPLES samples and MAX_POINTERS pointers.
 */

const Ajv2020 = require("ajv/dist/2020").default;
const { parsePointer } = require("./variant");
const {
  escapePointer,
  syncProtoPattern,
  setOwnKey,
  PROTO_KEY_PATTERN,
} = require("./infer");

const MAX_SAMPLES = 200;
const MAX_POINTERS = 20;

// ownProperties makes `required` use hasOwnProperty: a literal "__proto__"
// key is otherwise read via the prototype getter and never reports missing.
const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });

const POINTER_HINT =
  'JSON Pointer 须以 "/" 开头（空串 "" 表示根节点），"~" 仅允许写作 ~0（表示 ~）或 ~1（表示 /），并须指向 Schema 树中存在的节点（对象属性经 /properties/<键>、数组元素经 /items 逐段定位）';

const clone = (value) => JSON.parse(JSON.stringify(value));

function isPlainSchema(node) {
  return node !== null && typeof node === "object" && !Array.isArray(node);
}

/** Canonical string form of parsed segments ("" for the root). */
function displayPointer(segments) {
  return segments.length === 0 ? "" : `/${segments.map(escapePointer).join("/")}`;
}

/** True when every segment of `a` matches the head of `b` and `a` is shorter. */
function isStrictPrefix(a, b) {
  return a.length < b.length && a.every((segment, i) => segment === b[i]);
}

/** Walk the schema along parsed segments; true when every step exists. */
function resolves(schema, segments) {
  let node = schema;
  for (let i = 0; i < segments.length;) {
    if (!isPlainSchema(node)) return false;
    if (
      segments[i] === "properties" &&
      i + 1 < segments.length &&
      isPlainSchema(node.properties)
    ) {
      const key = segments[i + 1];
      if (!Object.prototype.hasOwnProperty.call(node.properties, key)) return false;
      node = node.properties[key];
      i += 2;
    } else if (segments[i] === "items" && isPlainSchema(node.items)) {
      node = node.items;
      i += 1;
    } else {
      return false;
    }
  }
  return true;
}

/** Selection trie mirroring the schema shape: props by key, items, selected. */
function trieNode() {
  return { selected: false, props: new Map(), items: null };
}

function insertPointer(root, segments) {
  let node = root;
  for (let i = 0; i < segments.length;) {
    if (segments[i] === "properties") {
      const key = segments[i + 1];
      if (!node.props.has(key)) node.props.set(key, trieNode());
      node = node.props.get(key);
      i += 2;
    } else {
      // "items" — resolvability was checked before the trie is built.
      if (!node.items) node.items = trieNode();
      node = node.items;
      i += 1;
    }
  }
  node.selected = true;
}

/**
 * Keep only the selected nodes plus their ancestor structure. A selected
 * subtree is cloned whole; an ancestor node keeps its non-structural
 * keywords (type union, const, ...) untouched, filters `properties` to the
 * keys on a selection path, intersects `required` with the survivors and
 * recurses into `items`.
 */
function sliceNode(node, trie) {
  if (trie.selected) return clone(node);
  if (!isPlainSchema(node)) return clone(node); // defensive: boolean schema
  const out = {};
  for (const [keyword, value] of Object.entries(node)) {
    // `properties`/`required`/`items` are sliced below; the "__proto__"
    // companion inside `patternProperties` is rebuilt from the surviving
    // `properties` entry instead of being copied through.
    if (
      keyword === "properties" ||
      keyword === "required" ||
      keyword === "items" ||
      keyword === "patternProperties"
    ) {
      continue;
    }
    out[keyword] = clone(value);
  }
  if (isPlainSchema(node.patternProperties)) {
    const patternProperties = {};
    for (const [pattern, child] of Object.entries(node.patternProperties)) {
      if (pattern === PROTO_KEY_PATTERN) continue; // re-derived after slicing
      // A user-authored schema could name a pattern "__proto__"; keep it safe.
      setOwnKey(patternProperties, pattern, clone(child));
    }
    if (Object.keys(patternProperties).length > 0) out.patternProperties = patternProperties;
  }
  if (isPlainSchema(node.properties)) {
    const properties = {};
    for (const [key, child] of Object.entries(node.properties)) {
      const childTrie = trie.props.get(key);
      if (!childTrie) continue;
      const sliced = sliceNode(child, childTrie);
      // "__proto__" must become an own data property, not hit the setter.
      setOwnKey(properties, key, sliced);
    }
    if (Object.keys(properties).length > 0) out.properties = properties;
    if (Array.isArray(node.required)) {
      const required = node.required.filter((key) =>
        Object.prototype.hasOwnProperty.call(properties, key)
      );
      if (required.length > 0) out.required = required;
    }
  }
  if (trie.items && isPlainSchema(node.items)) {
    out.items = sliceNode(node.items, trie.items);
  }
  // Re-add (or drop) the Ajv alias for a surviving (or removed) "__proto__".
  syncProtoPattern(out);
  return out;
}

/**
 * Project one sample along the selection trie. Selected subtrees are cloned
 * whole; ancestor objects keep only the keys on a selection path; ancestor
 * arrays map every element through the items selection; anything else
 * (scalars, or containers whose shape the selection does not walk) is kept
 * verbatim as the terminal of the ancestor chain.
 */
function projectValue(value, trie) {
  if (trie.selected) return clone(value);
  if (Array.isArray(value)) {
    return trie.items ? value.map((item) => projectValue(item, trie.items)) : clone(value);
  }
  if (value !== null && typeof value === "object") {
    if (trie.props.size === 0) return clone(value); // selection walks items only
    const out = {};
    for (const key of Object.keys(value)) {
      const childTrie = trie.props.get(key);
      if (childTrie) setOwnKey(out, key, projectValue(value[key], childTrie));
    }
    return out;
  }
  return value;
}

/** Number of `properties` fields kept in the slice schema, recursively. */
function countFields(node) {
  if (!isPlainSchema(node)) return 0;
  let count = 0;
  if (isPlainSchema(node.properties)) {
    for (const child of Object.values(node.properties)) {
      count += 1 + countFields(child);
    }
  }
  if (isPlainSchema(node.items)) count += countFields(node.items);
  return count;
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
 * Build the slice schema and the projected samples for the picked pointers.
 *
 * @returns {{ schema: object, samples: any[], fieldCount: number,
 *            sampleCount: number, pointers: string[],
 *            ignored: Array<{ pointer: string, reason: string }> }}
 */
function buildSlice({ schema, samples, pointers }) {
  if (!isPlainSchema(schema)) {
    throw Object.assign(new Error("Request body must contain a 'schema' object."), {
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
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per slice.`
      ),
      { status: 400 }
    );
  }
  if (!Array.isArray(pointers) || pointers.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'pointers' array."), {
      status: 400,
    });
  }
  if (pointers.length > MAX_POINTERS) {
    throw Object.assign(
      new Error(
        `Too many pointers: got ${pointers.length}, at most ${MAX_POINTERS} allowed per slice.`
      ),
      { status: 400 }
    );
  }
  for (const pointer of pointers) {
    if (typeof pointer !== "string") {
      throw Object.assign(
        new Error("Every pointer in 'pointers' must be a JSON Pointer string."),
        { status: 400 }
      );
    }
  }

  // Every pointer must parse (RFC 6901) and resolve to a real schema node.
  const invalidPointers = [];
  const parsed = pointers.map((pointer, index) => {
    const segments = parsePointer(pointer);
    if (segments === null) {
      invalidPointers.push({ index, pointer, reason: `Pointer 非法。${POINTER_HINT}` });
      return null;
    }
    if (!resolves(schema, segments)) {
      invalidPointers.push({
        index,
        pointer,
        reason: "未命中 Schema 中的节点，请核对路径",
      });
      return null;
    }
    return segments;
  });
  if (invalidPointers.length > 0) {
    const message = invalidPointers
      .map((p) => `第 ${p.index + 1} 个 Pointer（${p.pointer === "" ? "(root)" : p.pointer}）：${p.reason}`)
      .join("；");
    throw Object.assign(new Error(`${message}。未生成切片。`), {
      status: 422,
      details: { invalidPointers },
    });
  }

  // Ancestor wins, order-independent: a pointer covered by another selected
  // pointer is ignored; exact duplicates keep the first occurrence.
  const kept = []; // parsed segment arrays, first-seen order
  const ignored = [];
  parsed.forEach((segments, index) => {
    const pointer = pointers[index];
    const covering = parsed.find(
      (other, j) => j !== index && isStrictPrefix(other, segments)
    );
    if (covering) {
      ignored.push({
        pointer,
        reason: `已被祖先 ${displayPointer(covering) || "(root)"} 覆盖，该子项被忽略`,
      });
      return;
    }
    if (kept.some((other) => other.length === segments.length &&
        other.every((segment, i) => segment === segments[i]))) {
      ignored.push({ pointer, reason: "与前面的 Pointer 重复，已忽略" });
      return;
    }
    kept.push(segments);
  });

  const trie = trieNode();
  for (const segments of kept) insertPointer(trie, segments);

  const sliced = sliceNode(schema, trie);
  if (isPlainSchema(sliced) && sliced.$schema === undefined) {
    sliced.$schema = "https://json-schema.org/draft/2020-12/schema";
  }

  let validate;
  try {
    validate = ajv.compile(sliced);
  } catch (err) {
    throw Object.assign(new Error(`Invalid schema: ${err.message}`), { status: 422 });
  }

  const projected = samples.map((sample) => projectValue(sample, trie));
  const failures = [];
  projected.forEach((projectedSample, index) => {
    if (!validate(projectedSample)) {
      failures.push({ index, errors: mapErrors(validate) });
    }
  });
  if (failures.length > 0) {
    const shown = failures.slice(0, 10).map((f) => `#${f.index}`).join("、");
    const more = failures.length > 10 ? ` 等 ${failures.length} 条` : "";
    throw Object.assign(
      new Error(
        `投影样本未通过切片 Schema 校验（${failures.length}/${samples.length} 条失败：${shown}${more}），未产出切片。`
      ),
      { status: 422, details: { failures } }
    );
  }

  return {
    schema: sliced,
    samples: projected,
    fieldCount: countFields(sliced),
    sampleCount: samples.length,
    pointers: kept.map(displayPointer),
    ignored,
  };
}

module.exports = { buildSlice, MAX_SAMPLES, MAX_POINTERS, POINTER_HINT };
