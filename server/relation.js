"use strict";

/**
 * Field relation mining.
 *
 * Walks every sample and collects, per OBJECT POINTER SCOPE, the set of
 * fields that appear in that object instance:
 *
 *   - each object instance (including the root when it is an object) is one
 *     independent scope addressed by its schema JSON Pointer ("" for root,
 *     "/properties/<key>", "/items", "/properties/list/items/..."...);
 *   - array elements are counted independently: every element that is an
 *     object becomes its own scope at the same ".../items" pointer, and
 *     observations never cross a scope boundary (the parent object of an
 *     array and the objects nested inside its elements are distinct scopes);
 *   - positions where the sample carries a scalar/null (possible under type
 *     unions) contribute nothing at that scope.
 *
 * Within every scope two kinds of candidates are mined:
 *
 *   1. implication "A -> B" — every scope that contains A also contains B,
 *      with support = number of scopes containing A >= MIN_SUPPORT
 *      (confidence is 100% by construction);
 *   2. exclusion "A / B" — no scope contains both A and B, with
 *      support = min(count(A), count(B)) >= MIN_SUPPORT and a co-occurrence
 *      of 0 (the two fields are mutually exclusive).
 *
 * Implication edges are transitively reduced per scope (SCCs become a single
 * directed cycle; edges of the condensation DAG implied by a path of >= 2
 * edges are dropped). Exclusions are not transitive and are returned as-is.
 *
 * The enhancer applies chosen rules onto a clone of the inferred schema:
 *   - implication A -> B : dependentRequired: { A: [B, ...] }
 *   - exclusion A / B   : allOf: [ { not: { required: [A, B] } }, ... ]
 *
 * "__proto__" rules cannot use the plain keywords: Ajv skips a literal
 * `dependentRequired.__proto__` entry when iterating the schema, and without
 * its `ownProperties` option `required: ["__proto__"]` tests the *inherited*
 * prototype slot instead of the instance's own key, so a violating new sample
 * could pass (in either the antecedent or the consequent position). Rules
 * touching "__proto__" therefore use an own-key-only presence assertion built
 * from `propertyNames`, which iterates the instance's own property names and
 * never reads through Object.prototype — regardless of the validator's
 * `ownProperties` setting — while ordinary fields keep dependentRequired /
 * not-required exactly as before.
 *
 * Every ORIGINAL sample is then re-validated against the enhanced schema with
 * Ajv; a single failure refuses the run (422) together with the failing sample
 * indexes — no enhanced schema is produced.
 *
 * Rule identity
 * -------------
 * A rule is the quadruple (kind, scopePointer, fieldA, fieldB). Field names
 * come straight from JSON and may contain ANY character — including the tokens
 * used to render a rule ("|", "->", "<x>") and the RFC 6901 escape characters
 * "~" and "/" (and scope pointers embed those field names verbatim) — so the
 * id cannot rely on fixed separators or 6901 escaping alone: "a->b"/"c" and
 * "a"/"b->c" would otherwise render identically. The pointer and both fields
 * therefore carry an explicit decimal code-unit length prefix, which frames
 * every raw segment unambiguously:
 *
 *   implication|<plen>:<pointer>|<alen>:<rawA>-><blen>:<rawB>
 *   exclusion|<plen>:<pointer>|<alen>:<rawA><x><blen>:<rawB>
 *
 * Each boundary is structural (length header terminated by ":") rather than
 * lexical, so "|" appearing inside a pointer or a field never blurs a frame;
 * the id is injective over the quadruple and parseable back (parseRuleId).
 */

const Ajv2020 = require("ajv/dist/2020").default;
const { escapePointer, setOwnKey, PROTO_KEY } = require("./infer");

const MAX_SAMPLES = 200;
const MIN_SUPPORT = 2;
const MAX_WITNESS_PATHS = 50;

const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });

const clone = (value) => JSON.parse(JSON.stringify(value));

function isPlainSchema(node) {
  return node !== null && typeof node === "object" && !Array.isArray(node);
}

/**
 * Schema fragment asserting that the validated object carries `key` as an OWN
 * property.
 *
 * Plain `required: [key]` reads `data[key] !== undefined`, so for a key named
 * "__proto__" it observes Object.prototype (always present) instead of the
 * instance's own slot. `propertyNames` instead validates each of the object's
 * own enumerable property names against its subschema: "no own name differs
 * from `key`" can only hold when at least one own name equals `key` (an empty
 * name list vacuously has no differing name, hence the outer `not` flips it to
 * a failure). The check is therefore own-key based for ANY key, works whether
 * or not Ajv runs with `ownProperties`, and also matches an own "__proto__"
 * whose value is `undefined`/`null` (presence, not value, is what relation
 * rules mine).
 */
function ownKeyPresence(key) {
  return { not: { propertyNames: { not: { const: key } } } };
}

/** Implication "A present  =>  B present", own-key based on both sides. */
function implicationSchema(a, b) {
  return { if: ownKeyPresence(a), then: ownKeyPresence(b) };
}

/** Exclusion "A and B never co-occur", own-key based on both sides. */
function exclusionSchema(a, b) {
  return { not: { allOf: [ownKeyPresence(a), ownKeyPresence(b)] } };
}

/**
 * Collect every object scope across all samples.
 *
 * @param {any[]} samples
 * @returns {{ scopes: Array<{
 *              pointer: string,
 *              sampleIndex: number,
 *              path: string,
 *              present: Set<string>,
 *              keyOrder: string[]
 *            }>,
 *            pointerOrder: string[] }}
 */
function collectScopes(samples) {
  const scopes = [];
  const pointerOrder = [];
  const seenPointers = new Set();

  function rememberPointer(pointer) {
    if (!seenPointers.has(pointer)) {
      seenPointers.add(pointer);
      pointerOrder.push(pointer);
    }
  }

  function walk(value, pointer, sampleIndex, path) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, pointer ? `${pointer}/items` : "/items", sampleIndex, `${path}/${index}`);
      });
      return;
    }
    if (value === null || typeof value !== "object") return;

    rememberPointer(pointer);
    const present = new Set();
    const keyOrder = [];
    for (const key of Object.keys(value)) {
      present.add(key);
      keyOrder.push(key);
    }
    scopes.push({ pointer, sampleIndex, path, present, keyOrder });

    for (const key of keyOrder) {
      const escaped = escapePointer(key);
      walk(
        value[key],
        pointer ? `${pointer}/properties/${escaped}` : `/properties/${escaped}`,
        sampleIndex,
        `${path}/${escaped}`
      );
    }
  }

  samples.forEach((sample, index) => {
    walk(sample, "", index, `#/${index}`);
  });

  return { scopes, pointerOrder };
}

/** Tarjan SCC over the implication graph; fields are node indexes 0..n-1. */
function tarjan(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  for (const { from, to } of edges) adj[from].push(to);

  let indexCounter = 0;
  let stackCounter = 0;
  const indices = new Array(n).fill(-1);
  const low = new Array(n);
  const stack = [];
  const onStack = new Array(n).fill(false);
  const components = [];

  function strongConnect(v) {
    indices[v] = indexCounter;
    low[v] = indexCounter;
    indexCounter += 1;
    stack.push(v);
    onStack[v] = true;

    for (const w of adj[v]) {
      if (indices[w] === -1) {
        strongConnect(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v], indices[w]);
      }
    }

    if (low[v] === indices[v]) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack[w] = false;
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }

  for (let v = 0; v < n; v += 1) {
    if (indices[v] === -1) strongConnect(v);
  }
  // Components leave Tarjan in reverse topological (sink-first) order; flip
  // so source components come first.
  components.reverse();
  return components;
}

/**
 * Transitive reduction of the implication graph. Nodes are fields; edges are
 * `{ from, to }` and the relation is already known to be transitively valid
 * (every path of implication edges corresponds to an observed implication).
 *
 *  - multi-node SCCs keep one directed cycle over the component nodes (in
 *    node order, which is first-seen field order);
 *  - single-node SCCs keep no self edge;
 *  - between SCCs the condensation is a DAG, whose transitive reduction keeps
 *    exactly the edges not replaceable by a >= 2 edge path.
 */
function reduceImplications(nodes, edges) {
  const n = nodes.length;
  const components = tarjan(n, edges);

  const compOf = new Array(n);
  components.forEach((component, ci) => component.forEach((v) => {
    compOf[v] = ci;
  }));

  const keptKeys = new Set();
  const kept = [];
  const remember = (from, to) => {
    const key = `${from}>${to}`;
    if (!keptKeys.has(key)) {
      keptKeys.add(key);
      kept.push({ from, to });
    }
  };

  // Inside every non-trivial SCC, keep one directed cycle over all members
  // ordered by first-seen field order (node index), which implies every
  // intra-component edge without listing them all.
  for (const component of components) {
    if (component.length < 2) continue;
    const ordered = [...component].sort((a, b) => a - b);
    for (let i = 0; i < ordered.length; i += 1) {
      remember(ordered[i], ordered[(i + 1) % ordered.length]);
    }
  }

  // Condensation DAG: an inter-component edge is redundant when its target is
  // reachable from its source through >= 2 other condensation edges.
  const compCount = components.length;
  const condAdj = Array.from({ length: compCount }, () => new Set());
  for (const { from, to } of edges) {
    const cf = compOf[from];
    const ct = compOf[to];
    if (cf !== ct) condAdj[cf].add(ct);
  }

  for (let c = 0; c < compCount; c += 1) {
    for (const d of [...condAdj[c]]) {
      // DFS from c with the edge c -> d blocked; reaching d at depth >= 1
      // means a replacement path of at least two condensation edges exists.
      let found = false;
      const visited = new Set();
      const dfs = (node, depth) => {
        if (found) return;
        for (const next of condAdj[node]) {
          if (node === c && next === d) continue;
          if (next === d && depth >= 1) {
            found = true;
            return;
          }
          if (!visited.has(next)) {
            visited.add(next);
            dfs(next, depth + 1);
          }
        }
      };
      dfs(c, 0);
      if (found) continue;
      // Keep one representative original edge between the components,
      // preferring the smallest first-seen field pair.
      let chosen = null;
      for (const { from, to } of edges) {
        if (compOf[from] !== c || compOf[to] !== d) continue;
        if (chosen === null || from < chosen.from || (from === chosen.from && to < chosen.to)) {
          chosen = { from, to };
        }
      }
      if (chosen) remember(chosen.from, chosen.to);
    }
  }

  // Preserve the original edge ordering (first-seen field pairs).
  const order = new Map();
  edges.forEach((edge, i) => order.set(`${edge.from}>${edge.to}`, i));
  kept.sort((a, b) => order.get(`${a.from}>${a.to}`) - order.get(`${b.from}>${b.to}`));
  return kept;
}

const RULE_KINDS = { implication: "->", exclusion: "<x>" };

/**
 * Build the collision-free id for (kind, scopePointer, a, b). The pointer and
 * both field names are framed with an explicit code-unit length, so segments
 * containing "|", "->", "<x>", ":" or the RFC 6901 escape characters ("~",
 * "/") — and even digit/colon sequences — never blur a boundary. See the file
 * header.
 */
function makeRuleId(kind, pointer, a, b) {
  const join = RULE_KINDS[kind];
  const frame = (s) => `${String(s).length}:${s}`;
  return `${kind}|${frame(pointer)}|${frame(a)}${join}${frame(b)}`;
}

/**
 * Inverse of makeRuleId. Returns { kind, scopePointer, a, b } or null when the
 * id does not match the framed grammar (e.g. a stale id from an older build).
 */
function parseRuleId(id) {
  if (typeof id !== "string") return null;
  const firstBar = id.indexOf("|");
  if (firstBar === -1) return null;
  const kind = id.slice(0, firstBar);
  const join = RULE_KINDS[kind];
  if (!join) return null;

  const body = id.slice(firstBar + 1);
  let pos = 0;

  // Read one "<decimal-length>:<raw>" frame starting at `pos`, verify the raw
  // segment really has that length, then require `after` (an exact string) to
  // follow it (empty string = end of id must follow).
  function readFrame(after) {
    const colon = body.indexOf(":", pos);
    if (colon === -1) return null;
    const digits = body.slice(pos, colon);
    if (!/^\d+$/.test(digits)) return null; // digits only; no sign/leading junk
    const length = Number(digits);
    const start = colon + 1;
    const end = start + length;
    if (end > body.length) return null;
    const value = body.slice(start, end);
    pos = end;
    if (after === "") {
      if (pos !== body.length) return null;
    } else if (body.slice(pos, pos + after.length) !== after) {
      return null;
    } else {
      pos += after.length;
    }
    return value;
  }

  const pointer = readFrame("|");
  if (pointer === null) return null;
  const a = readFrame(join);
  if (a === null) return null;
  const b = readFrame("");
  if (b === null) return null;
  return { kind, scopePointer: pointer, a, b };
}

/** Resolve an object-typed schema node along a scope pointer ("" = root). */
function resolveSchemaNode(schema, pointer) {
  const segments = pointer === "" ? [] : pointer.split("/").slice(1);
  let node = schema;
  for (let i = 0; i < segments.length;) {
    if (!isPlainSchema(node)) return null;
    if (segments[i] === "properties" && i + 1 < segments.length) {
      const key = segments[i + 1].replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isPlainSchema(node.properties) ||
          !Object.prototype.hasOwnProperty.call(node.properties, key)) {
        return null;
      }
      node = node.properties[key];
      i += 2;
    } else if (segments[i] === "items") {
      if (!isPlainSchema(node.items)) return null;
      node = node.items;
      i += 1;
    } else {
      return null;
    }
  }
  return node;
}

/**
 * Mine all relation candidates from the samples. When `schema` is supplied
 * (the inferred schema), rules already enforced by plain `required` are
 * flagged `alreadyEnforced` so the UI can show why they add nothing.
 */
function mineRelations({ samples, schema = null }) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'samples' array."), {
      status: 400,
    });
  }
  if (samples.length > MAX_SAMPLES) {
    throw Object.assign(
      new Error(
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per relation mining.`
      ),
      { status: 400 }
    );
  }
  if (schema !== null && schema !== undefined && !isPlainSchema(schema)) {
    throw Object.assign(new Error("Request body must contain a 'schema' object."), {
      status: 400,
    });
  }

  const { scopes, pointerOrder } = collectScopes(samples);

  const groups = []; // one entry per pointer, in first-seen order
  let totalImplication = 0;
  let totalExclusion = 0;
  let removedByReduction = 0;

  for (const pointer of pointerOrder) {
    const groupScopes = scopes.filter((s) => s.pointer === pointer);

    // First-seen field order across scopes.
    const fieldOrder = [];
    const fieldSeen = new Set();
    for (const scope of groupScopes) {
      for (const key of scope.keyOrder) {
        if (!fieldSeen.has(key)) {
          fieldSeen.add(key);
          fieldOrder.push(key);
        }
      }
    }

    const counts = fieldOrder.map((field) =>
      groupScopes.reduce((acc, s) => acc + (s.present.has(field) ? 1 : 0), 0)
    );

    // Raw implication edges A -> B: count(A) >= MIN_SUPPORT and no scope
    // contains A without B. Exclusion pairs A / B: no co-occurrence and
    // both sides reach MIN_SUPPORT. Both skip trivial A == B.
    const rawImpl = [];
    const exclusions = [];
    for (let i = 0; i < fieldOrder.length; i += 1) {
      for (let j = 0; j < fieldOrder.length; j += 1) {
        if (i === j) continue;
        const a = fieldOrder[i];
        const b = fieldOrder[j];
        let aWithoutB = 0;
        let coOccurrence = 0;
        for (const scope of groupScopes) {
          const hasA = scope.present.has(a);
          const hasB = scope.present.has(b);
          if (hasA && !hasB) aWithoutB += 1;
          if (hasA && hasB) coOccurrence += 1;
        }
        if (counts[i] >= MIN_SUPPORT && aWithoutB === 0) {
          rawImpl.push({ from: i, to: j });
        }
        if (i < j && counts[i] >= MIN_SUPPORT && counts[j] >= MIN_SUPPORT && coOccurrence === 0) {
          exclusions.push({ from: i, to: j });
        }
      }
    }

    const reducedImpl = reduceImplications(fieldOrder, rawImpl);
    removedByReduction += rawImpl.length - reducedImpl.length;

    const schemaNode = schema ? resolveSchemaNode(schema, pointer) : null;
    const requiredKeys = new Set(
      schemaNode && Array.isArray(schemaNode.required) ? schemaNode.required : []
    );

    const buildWitnessPaths = (scopeIndexes) => {
      const paths = [];
      let truncated = false;
      for (const si of scopeIndexes) {
        if (paths.length >= MAX_WITNESS_PATHS) {
          truncated = true;
          break;
        }
        paths.push(groupScopes[si].path);
      }
      return { paths, truncated };
    };

    const implicationRules = reducedImpl.map(({ from, to }) => {
      const a = fieldOrder[from];
      const b = fieldOrder[to];
      const scopeIndexes = [];
      const sampleSet = new Set();
      groupScopes.forEach((scope, si) => {
        if (scope.present.has(a)) {
          scopeIndexes.push(si);
          sampleSet.add(scope.sampleIndex);
        }
      });
      const witness = buildWitnessPaths(scopeIndexes);
      return {
        id: makeRuleId("implication", pointer, a, b),
        kind: "implication",
        scopePointer: pointer,
        a,
        b,
        support: counts[from],
        scopeCount: groupScopes.length,
        confidence: 1,
        sampleIndexes: [...sampleSet].sort((x, y) => x - y),
        witnessPaths: witness.paths,
        witnessPathsTruncated: witness.truncated,
        alreadyEnforced: requiredKeys.has(b),
      };
    });

    const exclusionRules = exclusions.map(({ from, to }) => {
      const a = fieldOrder[from];
      const b = fieldOrder[to];
      const aScopes = [];
      const bScopes = [];
      const sampleSetA = new Set();
      const sampleSetB = new Set();
      groupScopes.forEach((scope, si) => {
        if (scope.present.has(a)) {
          aScopes.push(si);
          sampleSetA.add(scope.sampleIndex);
        }
        if (scope.present.has(b)) {
          bScopes.push(si);
          sampleSetB.add(scope.sampleIndex);
        }
      });
      const witnessA = buildWitnessPaths(aScopes);
      const witnessB = buildWitnessPaths(bScopes);
      return {
        id: makeRuleId("exclusion", pointer, a, b),
        kind: "exclusion",
        scopePointer: pointer,
        a,
        b,
        support: Math.min(counts[from], counts[to]),
        countA: counts[from],
        countB: counts[to],
        coOccurrence: 0,
        scopeCount: groupScopes.length,
        confidence: 1,
        sampleIndexes: [...new Set([...sampleSetA, ...sampleSetB])].sort((x, y) => x - y),
        witnessPathsA: witnessA.paths,
        witnessPathsB: witnessB.paths,
        witnessPathsTruncated: witnessA.truncated || witnessB.truncated,
      };
    });

    totalImplication += implicationRules.length;
    totalExclusion += exclusionRules.length;

    groups.push({
      scopePointer: pointer,
      scopeCount: groupScopes.length,
      fields: fieldOrder.map((field, i) => ({ name: field, count: counts[i] })),
      implications: implicationRules,
      exclusions: exclusionRules,
    });
  }

  return {
    sampleCount: samples.length,
    scopeCount: scopes.length,
    minSupport: MIN_SUPPORT,
    summary: {
      implication: totalImplication,
      exclusion: totalExclusion,
      removedByTransitiveReduction: removedByReduction,
    },
    scopes: groups,
  };
}

/**
 * Apply selected rules onto a clone of the schema and re-validate ALL
 * original samples with Ajv. Throws 422 (without producing a schema) when a
 * rule id is unknown or cannot be placed, the schema does not compile, or any
 * original sample fails the enhanced schema.
 */
function enhanceSchema({ schema, samples, ruleIds }) {
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
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per relation mining.`
      ),
      { status: 400 }
    );
  }
  if (!Array.isArray(ruleIds)) {
    throw Object.assign(new Error("Request body must contain a 'ruleIds' array."), {
      status: 400,
    });
  }
  for (const id of ruleIds) {
    if (typeof id !== "string") {
      throw Object.assign(new Error("Every rule id in 'ruleIds' must be a string."), {
        status: 400,
      });
    }
  }

  // Re-mine to resolve the ids: the selection can only be applied while the
  // observed evidence still matches the samples.
  const mined = mineRelations({ samples, schema });
  const ruleById = new Map();
  for (const group of mined.scopes) {
    for (const rule of [...group.implications, ...group.exclusions]) {
      ruleById.set(rule.id, rule);
    }
  }

  const invalidRules = [];
  const selected = [];
  const seenIds = new Set();
  ruleIds.forEach((id, index) => {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    const rule = ruleById.get(id);
    if (!rule) {
      invalidRules.push({ index, id, reason: "规则不存在或已因样本变化失效，请重新挖掘后再选择" });
      return;
    }
    selected.push(rule);
  });
  if (invalidRules.length > 0) {
    throw Object.assign(new Error("所选规则存在失效项，未生成增强 Schema。"), {
      status: 422,
      details: { invalidRules },
    });
  }

  const enhanced = clone(schema);
  if (enhanced.$schema === undefined) {
    enhanced.$schema = "https://json-schema.org/draft/2020-12/schema";
  }

  // Group the selected rules by their scope pointer and place them onto the
  // corresponding object schema node.
  const byPointer = new Map();
  for (const rule of selected) {
    if (!byPointer.has(rule.scopePointer)) byPointer.set(rule.scopePointer, []);
    byPointer.get(rule.scopePointer).push(rule);
  }

  for (const [pointer, rules] of byPointer) {
    const node = resolveSchemaNode(enhanced, pointer);
    if (!node) {
      throw Object.assign(
        new Error(`规则作用域 ${pointer || "(root)"} 在 Schema 中不存在，未生成增强 Schema。`),
        { status: 422 }
      );
    }

    for (const rule of rules) {
      if (rule.kind === "implication") {
        if (rule.a === PROTO_KEY || rule.b === PROTO_KEY) {
          // dependentRequired cannot reliably express presence of a literal
          // "__proto__" (Ajv skips the antecedent entry; the consequent reads
          // the inherited prototype slot without ownProperties), so the rule
          // is encoded with own-key-only propertyNames assertions.
          if (!Array.isArray(node.allOf)) node.allOf = [];
          node.allOf.push(implicationSchema(rule.a, rule.b));
          continue;
        }
        if (!isPlainSchema(node.dependentRequired)) node.dependentRequired = {};
        // hasOwnProperty: reading "__proto__" before it was written would
        // otherwise yield Object.prototype (truthy) and crash `new Set`.
        const existing = Object.prototype.hasOwnProperty.call(
          node.dependentRequired,
          rule.a
        )
          ? node.dependentRequired[rule.a]
          : [];
        const deps = new Set(existing);
        deps.add(rule.b);
        setOwnKey(node.dependentRequired, rule.a, [...deps].sort());
      } else {
        if (!Array.isArray(node.allOf)) node.allOf = [];
        if (rule.a === PROTO_KEY || rule.b === PROTO_KEY) {
          // not/required would treat the inherited prototype slot as a present
          // "__proto__" and reject documents that merely contain the other key.
          node.allOf.push(exclusionSchema(rule.a, rule.b));
        } else {
          node.allOf.push({ not: { required: [rule.a, rule.b] } });
        }
      }
    }
  }

  let validate;
  try {
    validate = ajv.compile(enhanced);
  } catch (err) {
    throw Object.assign(new Error(`Invalid schema: ${err.message}`), { status: 422 });
  }

  const failures = [];
  samples.forEach((sample, index) => {
    if (!validate(sample)) {
      failures.push({
        index,
        errors: (validate.errors || []).map((e) => ({
          path: e.instancePath || "",
          pointer: e.instancePath || "(root)",
          schemaPath: e.schemaPath,
          keyword: e.keyword,
          message: e.message,
          params: e.params,
        })),
      });
    }
  });
  if (failures.length > 0) {
    const shown = failures.slice(0, 10).map((f) => `#${f.index}`).join("、");
    const more = failures.length > 10 ? ` 等 ${failures.length} 条` : "";
    throw Object.assign(
      new Error(
        `原样本未全部通过增强 Schema 的 Ajv 复验（${failures.length}/${samples.length} 条失败：${shown}${more}），未产出增强 Schema。`
      ),
      { status: 422, details: { failures } }
    );
  }

  return {
    schema: enhanced,
    sampleCount: samples.length,
    ruleCount: selected.length,
    ruleIds: [...seenIds],
    rules: selected,
  };
}

module.exports = {
  mineRelations,
  enhanceSchema,
  collectScopes,
  reduceImplications,
  makeRuleId,
  parseRuleId,
  MAX_SAMPLES,
  MIN_SUPPORT,
};
