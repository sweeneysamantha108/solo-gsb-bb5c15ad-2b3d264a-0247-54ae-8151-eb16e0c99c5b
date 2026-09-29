"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeContribution,
  normalizeSchema,
  diffInferredSchemas,
  MAX_SAMPLES,
  VERDICTS,
} = require("../contribution");

test("identical samples are all redundant", () => {
  const { total, summary, samples } = analyzeContribution([
    { id: 1, name: "a" },
    { id: 2, name: "b" },
    { id: 3, name: "c" },
  ]);
  assert.equal(total, 3);
  assert.deepEqual(summary, { critical: 0, redundant: 3 });
  for (const item of samples) {
    assert.equal(item.verdict, "redundant");
    assert.deepEqual(item.affectedPointers, []);
  }
  assert.deepEqual([...Object.keys(summary)].sort(), [...VERDICTS].sort());
});

test("a sample carrying a unique field is critical with that field's pointer", () => {
  const { summary, samples } = analyzeContribution([
    { id: 1 },
    { id: 2 },
    { id: 3, email: "a@b.c" },
  ]);
  assert.deepEqual(summary, { critical: 1, redundant: 2 });
  assert.equal(samples[2].verdict, "critical");
  assert.deepEqual(samples[2].affectedPointers, ["/properties/email"]);
  assert.equal(samples[0].verdict, "redundant");
  assert.equal(samples[1].verdict, "redundant");
});

test("object key order never creates false differences", () => {
  // Removing either sample leaves a single object whose first-seen key order
  // differs from the full set's, but the RULES are identical.
  const { summary, samples } = analyzeContribution([
    { a: 1, b: 2 },
    { b: 3, a: 4 },
  ]);
  assert.deepEqual(summary, { critical: 0, redundant: 2 });
  for (const item of samples) assert.deepEqual(item.affectedPointers, []);
});

test("array element order never creates false differences", () => {
  const { summary } = analyzeContribution([
    { tags: ["a", 1, null] },
    { tags: [2, "b"] },
    { tags: [null, "c", 3] },
  ]);
  // Every element type (string/integer/null) survives any single removal.
  assert.deepEqual(summary, { critical: 0, redundant: 3 });
});

test("narrowing a root type union flags the contributing sample", () => {
  const { summary, samples } = analyzeContribution([1, "x", "y"]);
  assert.deepEqual(summary, { critical: 1, redundant: 2 });
  assert.equal(samples[0].verdict, "critical");
  assert.deepEqual(samples[0].affectedPointers, [""]); // root type union lost "integer"
  assert.equal(samples[1].verdict, "redundant");
  assert.equal(samples[2].verdict, "redundant");
});

test("integer-only remainder narrows number back to integer", () => {
  const { samples } = analyzeContribution([1, 2, 1.5]);
  assert.equal(samples[2].verdict, "critical"); // without 1.5 only integers remain
  assert.deepEqual(samples[2].affectedPointers, [""]);
  assert.equal(samples[0].verdict, "redundant"); // 2 and 1.5 still widen to number
  assert.equal(samples[1].verdict, "redundant");
});

test("null evidence is a rule like any other", () => {
  const { samples } = analyzeContribution([
    { phone: null },
    { phone: "x" },
    { phone: "y" },
  ]);
  assert.equal(samples[0].verdict, "critical");
  assert.deepEqual(samples[0].affectedPointers, ["/properties/phone"]);
  assert.equal(samples[1].verdict, "redundant");
});

test("removing the only optional-field gap flips required", () => {
  const { samples } = analyzeContribution([{ a: 1 }, { a: 2, b: 3 }, { a: 4, b: 5 }]);
  // Without sample 0, "b" is present in every remaining object -> required.
  assert.equal(samples[0].verdict, "critical");
  assert.deepEqual(samples[0].affectedPointers, ["/properties/b"]);
  assert.equal(samples[1].verdict, "redundant");
  assert.equal(samples[2].verdict, "redundant");
});

test("array items constraint changes are reported at the items pointer", () => {
  const { samples } = analyzeContribution([{ xs: [1] }, { xs: ["a"] }, { xs: ["b"] }]);
  assert.equal(samples[0].verdict, "critical");
  assert.deepEqual(samples[0].affectedPointers, ["/properties/xs/items"]);
  assert.equal(samples[1].verdict, "redundant");
  assert.equal(samples[2].verdict, "redundant");
});

test("empty-array-only remainder drops the items constraint", () => {
  const { samples } = analyzeContribution([{ xs: [1] }, { xs: [] }]);
  assert.equal(samples[0].verdict, "critical");
  assert.deepEqual(samples[0].affectedPointers, ["/properties/xs/items"]);
  // The empty array carries no item evidence: removing it changes nothing.
  assert.equal(samples[1].verdict, "redundant");
  assert.deepEqual(samples[1].affectedPointers, []);
});

test("nested pointers inside arrays of objects are reported", () => {
  const { samples } = analyzeContribution([
    { list: [{ k: 1 }] },
    { list: [{ k: 2, j: "a" }] },
  ]);
  assert.equal(samples[1].verdict, "critical");
  assert.deepEqual(samples[1].affectedPointers, ["/properties/list/items/properties/j"]);
});

test("each affected rule is counted exactly once", () => {
  // Removing sample 1 changes "a" (type union) and "b" (required flip):
  // two distinct pointers, no duplicates.
  const { samples } = analyzeContribution([{ a: 1, b: 1 }, { a: "x" }]);
  const critical = samples[1];
  assert.equal(critical.verdict, "critical");
  assert.deepEqual(critical.affectedPointers, ["/properties/a", "/properties/b"]);
  assert.equal(new Set(critical.affectedPointers).size, critical.affectedPointers.length);
});

test("a single sample is trivially critical (root pointer)", () => {
  const { total, summary, samples } = analyzeContribution([{ id: 1 }]);
  assert.equal(total, 1);
  assert.deepEqual(summary, { critical: 1, redundant: 0 });
  assert.deepEqual(samples[0], { index: 0, verdict: "critical", affectedPointers: [""] });
});

test("analyzeContribution rejects a missing or empty sample set with status 400", () => {
  for (const samples of [undefined, null, "nope", { 0: 1 }, 42, []]) {
    assert.throws(
      () => analyzeContribution(samples),
      (err) => err.status === 400 && /'samples' array/.test(err.message)
    );
  }
});

test(`analyzeContribution rejects more than ${MAX_SAMPLES} samples with status 400`, () => {
  const samples = Array.from({ length: MAX_SAMPLES + 1 }, () => 1);
  assert.throws(
    () => analyzeContribution(samples),
    (err) => err.status === 400 && new RegExp(`${MAX_SAMPLES}`).test(err.message)
  );
  // Exactly at the limit is fine.
  const ok = analyzeContribution(Array.from({ length: MAX_SAMPLES }, () => 1));
  assert.equal(ok.total, MAX_SAMPLES);
  assert.equal(ok.summary.redundant, MAX_SAMPLES);
});

test("normalizeSchema canonicalizes key order, required order and type shape", () => {
  const a = normalizeSchema({
    type: ["string", "null"],
    properties: { b: { type: "integer" }, a: { type: ["integer", "string"] } },
    required: ["b", "a"],
  });
  const b = normalizeSchema({
    type: ["null", "string"],
    properties: { a: { type: ["string", "integer"] }, b: { type: ["integer"] } },
    required: ["a", "b"],
  });
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a.properties), ["a", "b"]);
  assert.deepEqual(a.type, ["null", "string"]);
});

test("diffInferredSchemas reports no pointers for rule-equal schemas", () => {
  const { inferSchema } = require("../infer");
  const full = inferSchema([{ a: 1, b: 2 }, { b: 3, a: 4 }]).schema;
  const reduced = inferSchema([{ b: 3, a: 4 }]).schema;
  assert.deepEqual(diffInferredSchemas(full, reduced), []);
});

test("diffInferredSchemas sorts pointers and treats scalar/union type as equal", () => {
  const full = { type: "object", properties: { x: { type: "string" } } };
  const same = { type: ["object"], properties: { x: { type: ["string"] } } };
  assert.deepEqual(diffInferredSchemas(full, same), []);
  const changed = { type: "object", properties: { x: { type: ["string", "null"] } } };
  assert.deepEqual(diffInferredSchemas(full, changed), ["/properties/x"]);
});
