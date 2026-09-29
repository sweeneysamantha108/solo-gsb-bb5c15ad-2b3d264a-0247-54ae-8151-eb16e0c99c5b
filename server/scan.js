"use strict";

/**
 * Sample impact scanner.
 *
 * Given the baseline and current schema plus a historical sample set, every
 * sample is validated with Ajv against BOTH schemas and classified:
 *
 *   both         -> accepted by baseline AND current (unaffected)
 *   baselineOnly -> accepted by baseline, rejected by current (would break)
 *   currentOnly  -> rejected by baseline, accepted by current (newly valid)
 *   neither      -> rejected by both (already non-conforming)
 *
 * A single scan is capped at MAX_SAMPLES samples; the route surfaces shape
 * violations as 400 and uncompilable schemas as 422.
 */

const Ajv2020 = require("ajv/dist/2020").default;

const MAX_SAMPLES = 200;

const CATEGORIES = ["both", "baselineOnly", "currentOnly", "neither"];

const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });

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

function classify(oldValid, newValid) {
  if (oldValid && newValid) return "both";
  if (oldValid) return "baselineOnly";
  if (newValid) return "currentOnly";
  return "neither";
}

/**
 * Validate every sample against both schemas and tally the categories.
 *
 * @returns {{ total: number,
 *            summary: { both: number, baselineOnly: number,
 *                       currentOnly: number, neither: number },
 *            samples: Array<{ index: number, category: string,
 *                             baseline: object, current: object }> }}
 */
function scanSamples({ oldSchema, newSchema, samples }) {
  if (!Array.isArray(samples)) {
    throw Object.assign(new Error("Request body must contain a 'samples' array."), {
      status: 400,
    });
  }
  if (samples.length > MAX_SAMPLES) {
    throw Object.assign(
      new Error(
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per scan.`
      ),
      { status: 400 }
    );
  }

  let validateOld;
  let validateNew;
  try {
    validateOld = ajv.compile(oldSchema);
    validateNew = ajv.compile(newSchema);
  } catch (err) {
    throw Object.assign(new Error(`Invalid schema: ${err.message}`), { status: 422 });
  }

  const summary = { both: 0, baselineOnly: 0, currentOnly: 0, neither: 0 };
  const results = samples.map((sample, index) => {
    const oldValid = validateOld(sample);
    const oldErrors = oldValid ? [] : mapErrors(validateOld);
    const newValid = validateNew(sample);
    const newErrors = newValid ? [] : mapErrors(validateNew);
    const category = classify(oldValid, newValid);
    summary[category] += 1;
    return {
      index,
      category,
      baseline: { valid: oldValid, errors: oldErrors },
      current: { valid: newValid, errors: newErrors },
    };
  });
  return { total: samples.length, summary, samples: results };
}

module.exports = { scanSamples, MAX_SAMPLES, CATEGORIES };
