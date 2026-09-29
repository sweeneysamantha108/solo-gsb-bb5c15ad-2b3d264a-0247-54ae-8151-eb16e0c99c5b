"use strict";

/**
 * Sample contribution analyzer (leave-one-out via per-sample evidence).
 *
 * For each sample we ask which rules would change if that sample were removed:
 *
 *   critical -> removing the sample changes at least one rule
 *   redundant -> the remaining samples reproduce the exact same rules
 *
 * Instead of re-running the whole inference N times (N+1 inferences per run,
 * repeatedly walking the same payloads), every sample is folded into ONE
 * evidence tree aggregated by sample index. Each node keeps:
 *
 *   - type contributors:     which samples observed each JSON type here
 *                            (integer/number widened exactly like inference;
 *                            repeated values of one sample count once)
 *   - object counts:         how many object instances each sample placed
 *                            here (multiple array elements count separately)
 *   - per field:             per-sample presence counts — a field is required
 *                            exactly when every remaining object instance
 *                            carries it
 *   - array element counts:  per-sample number of array elements pushed into
 *                            `items` (multiple elements of one sample count
 *                            separately; an empty array contributes nothing,
 *                            so it never creates an `items` rule)
 *
 * The rules after removing sample k are then read straight out of the
 * aggregated counters with O(1) subtraction per rule — no second pass over
 * the payloads. The diff walks the normalized rule vocabulary of the
 * inference engine (`type` / `properties` / `required` / `items`) and reports
 * the schema JSON Pointer of every node whose rule differs. Pointers are
 * collected in a Set, so a node whose type AND required flag both flip still
 * counts once, and field/key order can never create a false difference (only
 * set/count equality matters).
 *
 * A single analysis is capped at MAX_SAMPLES samples.
 */

const { typeOf, escapePointer, setOwnKey } = require("./infer");

const MAX_SAMPLES = 50;

const VERDICTS = ["critical", "redundant"];

// Same canonical type order as the inference engine.
const TYPE_ORDER = ["null", "boolean", "integer", "number", "string", "array", "object"];

/** @returns {string[] | null} sorted type list, or null when unconstrained */
function normalizeTypeList(type) {
  if (type === undefined) return null;
  const list = Array.isArray(type) ? [...type] : [type];
  return list.sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
}

/**
 * Canonicalize an inferred schema so rule-equal schemas compare equal:
 * `type` becomes a sorted list, `required` is sorted, `properties` keys are
 * sorted, and the same is applied recursively to every subschema.
 */
function normalizeSchema(node) {
  const out = {};
  const types = normalizeTypeList(node && node.type);
  if (types !== null) out.type = types;
  const properties = node && node.properties;
  if (properties && typeof properties === "object") {
    const sorted = {};
    for (const key of Object.keys(properties).sort()) {
      setOwnKey(sorted, key, normalizeSchema(properties[key]));
    }
    out.properties = sorted;
  }
  if (node && Array.isArray(node.required)) {
    out.required = [...node.required].sort();
  }
  if (node && node.items && typeof node.items === "object") {
    out.items = normalizeSchema(node.items);
  }
  return out;
}

function sameTypeList(a, b) {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Collect the schema JSON Pointers whose rules differ between two NORMALIZED
 * inferred schemas. A property/items subtree that exists on only one side is
 * reported as a single pointer at its root (no descent into it), and every
 * pointer is added to a Set, so each affected rule is counted exactly once.
 */
function collectDiffPointers(a, b, pointer, out) {
  if (!sameTypeList(a.type || null, b.type || null)) out.add(pointer);

  const propsA = a.properties || {};
  const propsB = b.properties || {};
  const requiredA = new Set(a.required || []);
  const requiredB = new Set(b.required || []);
  for (const key of new Set([...Object.keys(propsA), ...Object.keys(propsB)])) {
    const childPointer = `${pointer}/properties/${escapePointer(key)}`;
    const inA = Object.prototype.hasOwnProperty.call(propsA, key);
    const inB = Object.prototype.hasOwnProperty.call(propsB, key);
    if (inA !== inB) {
      out.add(childPointer); // field appeared/disappeared entirely
      continue;
    }
    if (requiredA.has(key) !== requiredB.has(key)) out.add(childPointer); // required flip
    collectDiffPointers(propsA[key], propsB[key], childPointer, out);
  }

  const itemsA = a.items || null;
  const itemsB = b.items || null;
  const itemsPointer = `${pointer}/items`;
  if (itemsA && itemsB) {
    collectDiffPointers(itemsA, itemsB, itemsPointer, out);
  } else if (itemsA || itemsB) {
    out.add(itemsPointer); // element constraint appeared/disappeared
  }
}

/**
 * Schema-level diff of two inferred schemas (used by the UI/tests to compare
 * independently inferred contracts). The analyzer itself does not need this:
 * it derives leave-one-out diffs directly from aggregated per-sample
 * evidence. Pointers are sorted and de-duplicated.
 * @returns {string[]}
 */
function diffInferredSchemas(fullSchema, reducedSchema) {
  const pointers = new Set();
  collectDiffPointers(normalizeSchema(fullSchema), normalizeSchema(reducedSchema), "", pointers);
  return [...pointers].sort();
}

/**
 * One node of the aggregated evidence tree: every rule-relevant observation
 * made at one schema JSON Pointer, broken down by contributing sample index.
 */
class EvidenceNode {
  /**
   * @param {string} pointer schema JSON Pointer of this node
   */
  constructor(pointer) {
    this.pointer = pointer;
    // typeName -> Set of sample indexes that observed that type here.
    this.typeContributors = new Map();
    // sampleIndex -> number of object instances observed here by that sample.
    this.objects = new Map();
    this.totalObjects = 0;
    // Object keys in first-seen order (order is not a rule; kept only so the
    // field set is traversed deterministically).
    this.keyOrder = [];
    // fieldName -> { presence: Map(sampleIndex -> count), totalPresence, child }
    this.fields = new Map();
    // sampleIndex -> number of array elements pushed into `items`.
    this.items = new Map();
    this.totalItems = 0;
    /** @type {EvidenceNode | null} */
    this.itemsChild = null;
  }

  addType(sampleIndex, typeName) {
    let contributors = this.typeContributors.get(typeName);
    if (!contributors) {
      contributors = new Set();
      this.typeContributors.set(typeName, contributors);
    }
    contributors.add(sampleIndex);
  }

  addObject(sampleIndex, amount = 1) {
    this.objects.set(sampleIndex, (this.objects.get(sampleIndex) || 0) + amount);
    this.totalObjects += amount;
  }

  field(name) {
    let field = this.fields.get(name);
    if (!field) {
      field = { presence: new Map(), totalPresence: 0, child: null };
      this.fields.set(name, field);
      this.keyOrder.push(name);
    }
    return field;
  }

  addFieldPresence(field, sampleIndex) {
    field.presence.set(sampleIndex, (field.presence.get(sampleIndex) || 0) + 1);
    field.totalPresence += 1;
  }

  addItems(sampleIndex, amount = 1) {
    this.items.set(sampleIndex, (this.items.get(sampleIndex) || 0) + amount);
    this.totalItems += amount;
  }
}

/**
 * Apply the inference engine's integer-is-a-number widening to a raw set of
 * observed type names: once any decimal "number" is present, "integer" is
 * dropped (an integer is already a valid number).
 * @param {Set<string>} typeSet
 * @returns {Set<string>}
 */
function widenTypes(typeSet) {
  const out = new Set(typeSet);
  if (out.has("number")) out.delete("integer");
  return out;
}

/**
 * Fold every observation at this node into the evidence tree and recurse into
 * object fields and array elements.
 *
 * @param {EvidenceNode} node
 * @param {Array<{ sampleIndex: number, value: any }>} observations values seen
 *        at this node (multiple array elements of one sample arrive as
 *        separate observations sharing the same sampleIndex)
 */
function buildEvidence(node, observations) {
  for (const { sampleIndex, value } of observations) {
    node.addType(sampleIndex, typeOf(value));
  }

  const objectObs = observations.filter((o) => typeOf(o.value) === "object");
  for (const { sampleIndex, value } of objectObs) {
    node.addObject(sampleIndex);
    for (const key of Object.keys(value)) {
      // Keys come straight from JSON samples; a literal "__proto__" is a
      // normal own key (as JSON.parse treats it).
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        node.addFieldPresence(node.field(key), sampleIndex);
      }
    }
  }
  for (const key of node.keyOrder) {
    const childObservations = [];
    for (const { sampleIndex, value } of objectObs) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        childObservations.push({ sampleIndex, value: value[key] });
      }
    }
    const childPointer = `${node.pointer}/properties/${escapePointer(key)}`;
    const child = new EvidenceNode(childPointer);
    buildEvidence(child, childObservations);
    node.fields.get(key).child = child;
  }

  const itemObservations = [];
  for (const { sampleIndex, value } of observations) {
    if (typeOf(value) !== "array") continue;
    // Every element is its own item observation, so several objects/elements
    // in one sample's array are counted separately. Empty arrays add nothing
    // and therefore never create an `items` rule.
    for (const item of value) {
      node.addItems(sampleIndex);
      itemObservations.push({ sampleIndex, value: item });
    }
  }
  if (itemObservations.length > 0) {
    const child = new EvidenceNode(`${node.pointer}/items`);
    buildEvidence(child, itemObservations);
    node.itemsChild = child;
  }
}

/** Full (all-sample) type set at a node, widened exactly as inference does. */
function fullTypes(node) {
  return widenTypes(new Set(node.typeContributors.keys()));
}

/**
 * Type set present at a node after removing one sample. A type survives when
 * another sample still contributes it (or the removed sample never did); the
 * integer/number widening is applied afterwards.
 * @param {EvidenceNode} node
 * @param {number} excluded sample index to subtract
 * @returns {Set<string>}
 */
function remainingTypes(node, excluded) {
  const types = new Set();
  for (const [typeName, contributors] of node.typeContributors) {
    if (contributors.size > 1 || !contributors.has(excluded)) types.add(typeName);
  }
  return widenTypes(types);
}

function sameTypeSet(a, b) {
  if (a.size !== b.size) return false;
  for (const typeName of a) if (!b.has(typeName)) return false;
  return true;
}

/**
 * Collect the schema JSON Pointers whose rules differ between the full
 * evidence and the evidence left after removing sample `excluded`.
 *
 * @param {EvidenceNode} node node to inspect
 * @param {number} excluded sample index being removed
 * @param {Set<string>} out accumulated affected pointers
 */
function collectContributionPointers(node, excluded, out) {
  if (!sameTypeSet(fullTypes(node), remainingTypes(node, excluded))) {
    out.add(node.pointer);
  }

  // Object vocabulary (properties/required) exists at this node only while
  // object instances remain after the removal.
  const reducedObjectCount = node.totalObjects - (node.objects.get(excluded) || 0);
  if (node.totalObjects > 0 && reducedObjectCount > 0) {
    for (const key of node.keyOrder) {
      const field = node.fields.get(key);
      const childPointer = `${node.pointer}/properties/${escapePointer(key)}`;
      const reducedCount = field.totalPresence - (field.presence.get(excluded) || 0);

      if (field.totalPresence > 0 && reducedCount === 0) {
        out.add(childPointer); // field disappears entirely; subtree goes with it
        continue;
      }
      // Required = present in every object instance at this node (non-object
      // values do not vote); the flip itself is a rule change even when the
      // subtree rules survive.
      const fullRequired = field.totalPresence === node.totalObjects;
      const reducedRequired = reducedCount > 0 && reducedCount === reducedObjectCount;
      if (fullRequired !== reducedRequired) out.add(childPointer);
      if (reducedCount > 0 && field.child) {
        collectContributionPointers(field.child, excluded, out);
      }
    }
  } else if (node.totalObjects > 0) {
    // No object instance remains: the whole object vocabulary (properties +
    // required) vanishes. Report each disappearing field root once, without
    // descending into its subtree.
    for (const key of node.keyOrder) {
      out.add(`${node.pointer}/properties/${escapePointer(key)}`);
    }
  }

  const itemsPointer = `${node.pointer}/items`;
  const reducedItemCount = node.totalItems - (node.items.get(excluded) || 0);
  if (node.totalItems > 0 && reducedItemCount > 0 && node.itemsChild) {
    collectContributionPointers(node.itemsChild, excluded, out);
  } else if (node.totalItems > 0 && reducedItemCount === 0) {
    out.add(itemsPointer); // element evidence disappears: no items constraint
  }
}

/**
 * Classify every sample as critical or redundant by subtracting its
 * per-sample evidence from the single aggregated evidence tree.
 *
 * @param {any[]} samples
 * @returns {{ total: number,
 *            summary: { critical: number, redundant: number },
 *            samples: Array<{ index: number, verdict: string, affectedPointers: string[] }> }}
 */
function analyzeContribution(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'samples' array."), {
      status: 400,
    });
  }
  if (samples.length > MAX_SAMPLES) {
    throw Object.assign(
      new Error(
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per analysis.`
      ),
      { status: 400 }
    );
  }

  const root = new EvidenceNode("");
  buildEvidence(
    root,
    samples.map((value, sampleIndex) => ({ sampleIndex, value }))
  );

  const results = samples.map((_, index) => {
    if (samples.length === 1) {
      // Removing the only sample leaves nothing to infer from: the whole
      // contract (root) depends on it.
      return { index, verdict: "critical", affectedPointers: [""] };
    }
    const pointers = new Set();
    collectContributionPointers(root, index, pointers);
    const affectedPointers = [...pointers].sort();
    return {
      index,
      verdict: affectedPointers.length === 0 ? "redundant" : "critical",
      affectedPointers,
    };
  });

  const summary = { critical: 0, redundant: 0 };
  for (const result of results) summary[result.verdict] += 1;
  return { total: samples.length, summary, samples: results };
}

module.exports = {
  analyzeContribution,
  normalizeSchema,
  diffInferredSchemas,
  MAX_SAMPLES,
  VERDICTS,
};
