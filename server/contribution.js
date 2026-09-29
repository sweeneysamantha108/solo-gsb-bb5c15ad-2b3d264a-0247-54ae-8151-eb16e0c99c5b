"use strict";

/**
 * Sample contribution analyzer (leave-one-out).
 *
 * For each sample we re-infer the schema from the remaining N-1 samples and
 * compare it against the schema inferred from the full set:
 *
 *   critical -> removing the sample changes at least one rule
 *   redundant -> the remaining samples reproduce the exact same rules
 *
 * Both schemas are normalized before comparison so that purely cosmetic
 * differences never count as rule changes:
 *
 *   - `properties` key order (first-seen order shifts when a sample leaves)
 *   - `required` array order
 *   - `type` written as a scalar vs. a one-element union
 *
 * The diff walks the normalized rule vocabulary of the inference engine
 * (`type` / `properties` / `required` / `items`) and reports the schema JSON
 * Pointer of every node whose rule differs. Pointers are collected in a Set,
 * so a node whose type AND required flag both flip still counts once.
 *
 * A single analysis is capped at MAX_SAMPLES samples (N+1 inferences per run).
 */

const { inferSchema, escapePointer, setOwnKey } = require("./infer");

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
 * @param {object} fullSchema schema inferred from all samples
 * @param {object} reducedSchema schema inferred without one sample
 * @returns {string[]} sorted, de-duplicated schema JSON Pointers of changed rules
 */
function diffInferredSchemas(fullSchema, reducedSchema) {
  const pointers = new Set();
  collectDiffPointers(normalizeSchema(fullSchema), normalizeSchema(reducedSchema), "", pointers);
  return [...pointers].sort();
}

/**
 * Classify every sample as critical or redundant via leave-one-out inference.
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

  const { schema: fullSchema } = inferSchema(samples);

  const results = samples.map((_, index) => {
    if (samples.length === 1) {
      // Removing the only sample leaves nothing to infer from: the whole
      // contract (root) depends on it.
      return { index, verdict: "critical", affectedPointers: [""] };
    }
    const reduced = samples.filter((_, i) => i !== index);
    const { schema: reducedSchema } = inferSchema(reduced);
    const affectedPointers = diffInferredSchemas(fullSchema, reducedSchema);
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
