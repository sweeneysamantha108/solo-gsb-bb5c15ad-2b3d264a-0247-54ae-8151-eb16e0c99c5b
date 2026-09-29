"use strict";

/**
 * Sample contribution analyzer (leave-one-out).
 *
 * A naive analyzer infers the schema from all N samples and then, for every
 * sample, infers it again from the remaining N-1 samples: N+1 inference
 * passes that each walk the whole data set (O(N^2) evidence visits). With
 * inputs close to the 50-sample cap and deeply nested arrays the same
 * evidence is traversed over and over.
 *
 * Instead the analyzer walks the samples exactly ONCE and aggregates the
 * evidence by sample index into a pointer-indexed tree:
 *
 *   - a per-sample type bit-mask contributed at each node
 *   - how many objects each sample contributed there
 *   - per property: how many of that sample's objects carried the field
 *   - per node: how many array elements each sample contributed there
 *
 * Full-set totals (type mask, object count, field occurrences, element
 * count) are accumulated alongside. The analysis then walks the evidence
 * tree exactly ONCE: at every rule pointer it determines, in O(1) per
 * sample, which samples would change that rule upon removal, and adds the
 * pointer to each such sample's result. No sample is ever re-traversed and
 * no schema is re-inferred. Each array object a sample contains is counted
 * separately (its field-presence evidence adds up), and empty arrays
 * contribute zero elements, so they never create an `items` constraint.
 *
 * The rule vocabulary is the inference engine's: `type` / `properties` /
 * `required` / `items`. Property key order and required order are treated as
 * sets, so purely cosmetic shifts never count as rule changes. Each changed
 * rule is one schema JSON Pointer, so a node whose type AND required flag
 * both flip still counts once per sample.
 *
 * A single analysis is capped at MAX_SAMPLES samples (N <= 50, so the dense
 * per-node/per-sample counter arrays stay small).
 */

const { escapePointer, setOwnKey } = require("./infer");

const MAX_SAMPLES = 50;

const VERDICTS = ["critical", "redundant"];

// Same canonical type order as the inference engine.
const TYPE_ORDER = ["null", "boolean", "integer", "number", "string", "array", "object"];
const TYPE_BITS = Object.fromEntries(TYPE_ORDER.map((t, i) => [t, 1 << i]));
const INTEGER_BIT = TYPE_BITS.integer;
const NUMBER_BIT = TYPE_BITS.number;
// Bit -> index within TYPE_ORDER, used to bump per-type holder counters.
const TYPE_INDEX_OF_BIT = {};
TYPE_ORDER.forEach((_, i) => {
  TYPE_INDEX_OF_BIT[1 << i] = i;
});

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
      // setOwnKey keeps a literal "__proto__" key an own property (like
      // JSON.parse and the inference engine do) instead of replacing the
      // holder's prototype, which would silently drop the rule.
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

/** Decode a (widened) type bit-mask into the engine's canonical type list. */
function typesFromMask(mask) {
  // An integer is already a valid number: widen instead of unioning.
  if (mask & NUMBER_BIT) mask &= ~INTEGER_BIT;
  const list = [];
  for (let i = 0; i < TYPE_ORDER.length; i++) {
    if (mask & (1 << i)) list.push(TYPE_ORDER[i]);
  }
  return list; // TYPE_ORDER is already canonical
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
 * @param {object} fullSchema schema inferred from all samples
 * @param {object} reducedSchema schema inferred without one sample
 * @returns {string[]} sorted, de-duplicated schema JSON Pointers of changed rules
 */
function diffInferredSchemas(fullSchema, reducedSchema) {
  const pointers = new Set();
  collectDiffPointers(normalizeSchema(fullSchema), normalizeSchema(reducedSchema), "", pointers);
  return [...pointers].sort();
}

/* ------------------------------------------------------------------ */
/* Evidence aggregation                                                */
/* ------------------------------------------------------------------ */

/**
 * One node of the aggregated evidence tree, keyed by schema JSON Pointer.
 * Dense per-sample counters (N <= MAX_SAMPLES) let the analysis subtract a
 * sample's evidence in O(1); full-set totals accumulate during collection.
 *
 * @typedef {object} EvidenceNode
 * @property {Uint8Array} typeMasks       type bit-mask each sample observed
 * @property {number[]} typeHolderCounts  samples carrying each of 7 types
 * @property {number} fullMask            OR of all per-sample type masks
 * @property {Uint32Array} objectCounts   object observations per sample
 * @property {number} fullObjectCount     total object observations
 * @property {Map<string, PropertyEvidence>} properties
 * @property {{ elementCounts: Uint32Array, fullElements: number, child: EvidenceNode } | null} items
 *
 * @typedef {object} PropertyEvidence
 * @property {Uint32Array} counts objects of this sample carrying the field
 * @property {number} fullOccurrences total field occurrences
 * @property {EvidenceNode} child evidence reached through the field
 */
function createEvidenceNode(sampleCount) {
  return {
    typeMasks: new Uint8Array(sampleCount),
    typeHolderCounts: new Array(TYPE_ORDER.length).fill(0),
    fullMask: 0,
    objectCounts: new Uint32Array(sampleCount),
    fullObjectCount: 0,
    properties: new Map(),
    items: null,
  };
}

function typeBitOf(value) {
  if (value === null) return TYPE_BITS.null;
  if (Array.isArray(value)) return TYPE_BITS.array;
  switch (typeof value) {
    case "boolean":
      return TYPE_BITS.boolean;
    case "number":
      return Number.isInteger(value) ? TYPE_BITS.integer : TYPE_BITS.number;
    case "string":
      return TYPE_BITS.string;
    default:
      return TYPE_BITS.object;
  }
}

/**
 * Fold one value (observed in one sample) into an evidence node and recurse
 * into its object fields and array elements. Each array element is visited
 * separately, so multiple array objects in one sample are counted on their
 * own and empty arrays add no element evidence.
 */
function collectEvidence(value, sampleIndex, node) {
  const bit = typeBitOf(value);
  // The first time this sample shows a type here, count one more holder.
  if ((node.typeMasks[sampleIndex] & bit) === 0) {
    node.typeHolderCounts[TYPE_INDEX_OF_BIT[bit]] += 1;
  }
  node.typeMasks[sampleIndex] |= bit;
  node.fullMask |= bit;

  if (bit === TYPE_BITS.object) {
    node.objectCounts[sampleIndex] += 1;
    node.fullObjectCount += 1;
    for (const key of Object.keys(value)) {
      let entry = node.properties.get(key);
      if (!entry) {
        entry = {
          counts: new Uint32Array(node.objectCounts.length),
          fullOccurrences: 0,
          child: createEvidenceNode(node.objectCounts.length),
        };
        node.properties.set(key, entry);
      }
      entry.counts[sampleIndex] += 1;
      entry.fullOccurrences += 1;
      collectEvidence(value[key], sampleIndex, entry.child);
    }
  } else if (bit === TYPE_BITS.array && value.length > 0) {
    if (!node.items) {
      node.items = {
        elementCounts: new Uint32Array(node.objectCounts.length),
        fullElements: 0,
        child: createEvidenceNode(node.objectCounts.length),
      };
    }
    node.items.elementCounts[sampleIndex] += value.length;
    node.items.fullElements += value.length;
    for (const item of value) {
      collectEvidence(item, sampleIndex, node.items.child);
    }
  }
}

/** Type union (widened) left at a node after removing one sample. */
function reducedMaskAfterRemoval(node, sample) {
  const removedMask = node.typeMasks[sample];
  let reducedMask = 0;
  for (let i = 0; i < TYPE_ORDER.length; i++) {
    if (node.typeHolderCounts[i] - (removedMask & (1 << i) ? 1 : 0) > 0) {
      reducedMask |= 1 << i;
    }
  }
  return reducedMask;
}

/**
 * Walk the aggregated evidence tree exactly once, evaluating every sample's
 * subtraction at each node. `parentAlive[s]` marks samples for which this
 * node still exists in the reduced inference (an ancestor property/items
 * node kept its evidence). A pointer is added to `affected[sample]` when
 * removing that sample changes the rule at this pointer:
 *
 *   - the node loses all evidence            -> pointer; subtree covered
 *   - the type union narrows                 -> pointer
 *   - a property disappears / required flips -> property pointer
 *   - the array items constraint disappears  -> items pointer
 *
 * Recursion into a child for a sample only continues while that child still
 * has the sample-independent remainder of evidence, mirroring the
 * schema-level diff which reports a vanished subtree as a single root
 * pointer without descending into it.
 */
function buildContributions(node, pointer, affected, parentAlive) {
  const sampleCount = node.typeMasks.length;
  if (!parentAlive) {
    parentAlive = new Uint8Array(sampleCount);
    for (let s = 0; s < sampleCount; s++) parentAlive[s] = 1;
  }

  // Whether THIS node survives each sample's removal.
  const alive = new Uint8Array(sampleCount);
  const fullTypes = typesFromMask(node.fullMask);
  for (let s = 0; s < sampleCount; s++) {
    if (!parentAlive[s]) continue;
    const mask = reducedMaskAfterRemoval(node, s);
    alive[s] = mask === 0 ? 0 : 1;
    if (mask === 0) {
      affected[s].add(pointer); // whole subtree loses its evidence
    } else if (sameTypeList(fullTypes, typesFromMask(mask)) === false) {
      affected[s].add(pointer); // type union narrows (incl. number->integer)
    }
  }

  if (node.fullObjectCount > 0) {
    for (const [key, entry] of node.properties) {
      const childPointer = `${pointer}/properties/${escapePointer(key)}`;
      const fullRequired = entry.fullOccurrences === node.fullObjectCount;
      const childAlive = new Uint8Array(sampleCount);
      for (let s = 0; s < sampleCount; s++) {
        if (!alive[s]) continue; // node vanished: subtree already reported
        const reducedObjectCount = node.fullObjectCount - node.objectCounts[s];
        const reducedOccurrences = entry.fullOccurrences - entry.counts[s];
        if (reducedOccurrences === 0) {
          affected[s].add(childPointer); // field disappears entirely
          continue; // child subtree covered by the field's root pointer
        }
        childAlive[s] = 1;
        // Required iff present in every object observation of this scope.
        if (fullRequired !== (reducedOccurrences === reducedObjectCount)) {
          affected[s].add(childPointer);
        }
      }
      let anyChildAlive = false;
      for (let s = 0; s < sampleCount; s++) {
        if (childAlive[s]) {
          anyChildAlive = true;
          break;
        }
      }
      if (anyChildAlive) buildContributions(entry.child, childPointer, affected, childAlive);
    }
  }

  if (node.items) {
    const itemsPointer = `${pointer}/items`;
    const childAlive = new Uint8Array(sampleCount);
    for (let s = 0; s < sampleCount; s++) {
      if (!alive[s]) continue;
      // Empty arrays carry no element evidence: items exists iff count > 0.
      if (node.items.fullElements - node.items.elementCounts[s] === 0) {
        affected[s].add(itemsPointer); // nested items constraint vanishes
      } else {
        childAlive[s] = 1;
      }
    }
    let anyChildAlive = false;
    for (let s = 0; s < sampleCount; s++) {
      if (childAlive[s]) {
        anyChildAlive = true;
        break;
      }
    }
    if (anyChildAlive) buildContributions(node.items.child, itemsPointer, affected, childAlive);
  }
}

/**
 * Classify every sample as critical or redundant via leave-one-out evidence.
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

  // Removing the only sample leaves nothing to infer from: the whole contract
  // (root) depends on it.
  if (samples.length === 1) {
    const result = { index: 0, verdict: "critical", affectedPointers: [""] };
    return { total: 1, summary: { critical: 1, redundant: 0 }, samples: [result] };
  }

  // Single traversal: aggregate every sample's evidence by sample index.
  const root = createEvidenceNode(samples.length);
  samples.forEach((value, index) => collectEvidence(value, index, root));

  // One walk over the evidence tree decides every sample's affected rules.
  const affected = Array.from({ length: samples.length }, () => new Set());
  buildContributions(root, "", affected, null);

  const results = samples.map((_, index) => {
    const affectedPointers = [...affected[index]].sort();
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
