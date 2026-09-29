"use strict";

/**
 * Error hotspot analysis.
 *
 * A pasted set of up to MAX_SAMPLES samples is validated one by one against
 * the current schema with Ajv (`allErrors`). The errors are then clustered by
 * the rule that produced them — Ajv's `schemaPath` plus `keyword` — so the
 * same rule failing at different array indexes (e.g. `/tags/0` and `/tags/1`)
 * lands in a single cluster. Two keywords must stay split by their params,
 * because one shared schemaPath would otherwise merge distinct property
 * violations:
 *
 *   required             -> clustered per `params.missingProperty`
 *   additionalProperties -> clustered per `params.additionalProperty`
 *
 * Every cluster reports the affected-sample count, the total error count,
 * the affected sample indexes and the original instance pointers; clusters
 * are sorted by affected-sample count, descending. Shape violations surface
 * as 400 and an uncompilable schema as 422.
 */

const Ajv2020 = require("ajv/dist/2020").default;

const MAX_SAMPLES = 200;

const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });

// Keywords whose params take part in the cluster identity.
const PARAM_KEYS = {
  required: "missingProperty",
  additionalProperties: "additionalProperty",
};

function clusterKeyOf(error) {
  const paramKey = PARAM_KEYS[error.keyword];
  const paramValue = paramKey ? String(error.params?.[paramKey] ?? "") : "";
  return { key: `${error.schemaPath}\n${error.keyword}\n${paramValue}`, paramKey };
}

/**
 * Validate every sample against the schema and cluster the errors by rule.
 *
 * @returns {{ total: number, validCount: number, invalidCount: number,
 *            errorCount: number, clusterCount: number,
 *            clusters: Array<object> }}
 */
function analyzeHotspots({ schema, samples }) {
  if (!Array.isArray(samples)) {
    throw Object.assign(new Error("Request body must contain a 'samples' array."), {
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

  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    throw Object.assign(new Error(`Invalid schema: ${err.message}`), { status: 422 });
  }

  const clusters = new Map();
  let validCount = 0;
  let errorCount = 0;

  samples.forEach((sample, index) => {
    const valid = validate(sample);
    if (valid) {
      validCount += 1;
      return;
    }
    for (const e of validate.errors || []) {
      errorCount += 1;
      const { key, paramKey } = clusterKeyOf(e);
      let cluster = clusters.get(key);
      if (!cluster) {
        cluster = {
          schemaPath: e.schemaPath,
          keyword: e.keyword,
          // Only required / additionalProperties carry a discriminating param.
          ...(paramKey ? { [paramKey]: e.params?.[paramKey] } : {}),
          sampleCount: 0,
          errorCount: 0,
          sampleIndexes: [],
          occurrences: [],
        };
        clusters.set(key, cluster);
      }
      // Samples are processed in order, so the last index differs whenever
      // this error belongs to a newly affected sample.
      if (cluster.sampleIndexes[cluster.sampleIndexes.length - 1] !== index) {
        cluster.sampleIndexes.push(index);
        cluster.sampleCount += 1;
      }
      cluster.errorCount += 1;
      cluster.occurrences.push({
        index,
        path: e.instancePath || "",
        pointer: e.instancePath || "(root)",
        message: e.message,
        params: e.params,
      });
    }
  });

  const sorted = [...clusters.entries()]
    .sort(
      (a, b) =>
        b[1].sampleCount - a[1].sampleCount ||
        b[1].errorCount - a[1].errorCount ||
        a[0].localeCompare(b[0])
    )
    .map(([, cluster]) => cluster);

  return {
    total: samples.length,
    validCount,
    invalidCount: samples.length - validCount,
    errorCount,
    clusterCount: sorted.length,
    clusters: sorted,
  };
}

module.exports = { analyzeHotspots, MAX_SAMPLES };
