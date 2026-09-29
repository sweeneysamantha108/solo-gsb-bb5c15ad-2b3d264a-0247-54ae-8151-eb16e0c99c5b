"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scanSamples, MAX_SAMPLES, CATEGORIES } = require("../scan");

// Each side accepts one type the other rejects, so all four categories
// are reachable: "s" both, null baselineOnly, 5 currentOnly, false neither.
const oldSchema = { type: ["string", "null"] };
const newSchema = { type: ["string", "integer"] };

test("scanSamples classifies every sample into one of four categories", () => {
  const { total, summary, samples } = scanSamples({
    oldSchema,
    newSchema,
    samples: ["s", null, 5, false],
  });
  assert.equal(total, 4);
  assert.deepEqual(summary, { both: 1, baselineOnly: 1, currentOnly: 1, neither: 1 });
  assert.deepEqual(
    samples.map((s) => [s.index, s.category]),
    [
      [0, "both"],
      [1, "baselineOnly"],
      [2, "currentOnly"],
      [3, "neither"],
    ]
  );
  assert.deepEqual([...Object.keys(summary)].sort(), [...CATEGORIES].sort());
});

test("scanSamples reports per-side validity and Ajv errors with pointers", () => {
  const oldS = {
    type: "object",
    properties: { id: { type: "integer" }, phone: { type: ["null", "string"] } },
    required: ["id", "phone"],
  };
  const newS = {
    type: "object",
    properties: { id: { type: "integer" }, phone: { type: "string" } },
    required: ["id", "phone"],
  };
  const { samples } = scanSamples({ oldSchema: oldS, newSchema: newS, samples: [{ id: 1, phone: null }] });
  const [item] = samples;
  assert.equal(item.category, "baselineOnly");
  assert.equal(item.baseline.valid, true);
  assert.deepEqual(item.baseline.errors, []);
  assert.equal(item.current.valid, false);
  assert.equal(item.current.errors.length, 1);
  const err = item.current.errors[0];
  assert.equal(err.pointer, "/phone");
  assert.equal(err.path, "/phone");
  assert.equal(err.keyword, "type");
  assert.ok(typeof err.message === "string" && err.message.length > 0);
  assert.ok(err.schemaPath);
});

test("scanSamples accepts an empty sample set", () => {
  const { total, summary, samples } = scanSamples({ oldSchema: {}, newSchema: {}, samples: [] });
  assert.equal(total, 0);
  assert.deepEqual(summary, { both: 0, baselineOnly: 0, currentOnly: 0, neither: 0 });
  assert.deepEqual(samples, []);
});

test("scanSamples rejects a non-array sample set with status 400", () => {
  for (const samples of [undefined, null, "nope", { 0: 1 }, 42]) {
    assert.throws(
      () => scanSamples({ oldSchema: {}, newSchema: {}, samples }),
      (err) => err.status === 400 && /'samples' array/.test(err.message)
    );
  }
});

test(`scanSamples rejects more than ${MAX_SAMPLES} samples with status 400`, () => {
  const samples = Array.from({ length: MAX_SAMPLES + 1 }, () => 1);
  assert.throws(
    () => scanSamples({ oldSchema: {}, newSchema: {}, samples }),
    (err) => err.status === 400 && new RegExp(`${MAX_SAMPLES}`).test(err.message)
  );
  // Exactly at the limit is fine.
  const ok = scanSamples({
    oldSchema: {},
    newSchema: {},
    samples: Array.from({ length: MAX_SAMPLES }, () => 1),
  });
  assert.equal(ok.total, MAX_SAMPLES);
  assert.equal(ok.summary.both, MAX_SAMPLES);
});

test("scanSamples rejects an uncompilable schema with status 422", () => {
  assert.throws(
    () => scanSamples({ oldSchema: { type: "not-a-type" }, newSchema: {}, samples: [1] }),
    (err) => err.status === 422 && /Invalid schema/.test(err.message)
  );
  assert.throws(
    () => scanSamples({ oldSchema: {}, newSchema: { type: "not-a-type" }, samples: [1] }),
    (err) => err.status === 422 && /Invalid schema/.test(err.message)
  );
});
