"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inferSchema } = require("../infer");
const { compareSchemas } = require("../diff");
const { generateCounterexample } = require("../counterexample");

const infer = (samples) => inferSchema(samples).schema;

/** Find the first breaking change of a given kind (or any breaking kind). */
function breakingChange(oldS, newS, perspective, kind) {
  const { changes } = compareSchemas(oldS, newS, perspective);
  return changes.find((c) => c.severity === "breaking" && (!kind || c.kind === kind));
}

function generate(oldS, newS, perspective, change) {
  const target = change || breakingChange(oldS, newS, perspective);
  assert.ok(target, "expected at least one breaking change");
  return generateCounterexample({
    oldSchema: oldS,
    newSchema: newS,
    perspective,
    kind: target.kind,
    pointer: target.pointer,
  });
}

function assertDirection(result, perspective) {
  assert.equal(result.constructible, true, result.reason || "expected constructible");
  assert.ok(result.sample !== undefined, "sample must be returned");
  if (perspective === "request") {
    assert.equal(result.oldResult.valid, true, "request: sample must pass OLD schema");
    assert.equal(result.newResult.valid, false, "request: sample must fail NEW schema");
    assert.ok(result.newResult.errors.length > 0, "new side must report errors");
    assert.deepEqual(result.oldResult.errors, []);
  } else {
    assert.equal(result.newResult.valid, true, "response: sample must pass NEW schema");
    assert.equal(result.oldResult.valid, false, "response: sample must fail OLD schema");
    assert.ok(result.oldResult.errors.length > 0, "old side must report errors");
    assert.deepEqual(result.newResult.errors, []);
  }
}

test("request: newly required existing property -> document omits only that key", () => {
  const oldS = infer([{ id: 1, name: "a" }, { id: 2 }]);
  const newS = infer([{ id: 1, name: "a" }, { id: 2, name: "b" }]);
  const change = breakingChange(oldS, newS, "request", "required-added");
  const result = generate(oldS, newS, "request", change);
  assertDirection(result, "request");
  assert.deepEqual(result.sample, { id: 0 });
  assert.equal(result.newResult.errors[0].keyword, "required");
  assert.equal(result.newResult.errors[0].params.missingProperty, "name");
});

test("request: brand-new required property -> document accepted by old, rejected by new", () => {
  const oldS = infer([{ id: 1 }]);
  const newS = infer([{ id: 1, email: "a@x.com" }]);
  const result = generate(oldS, newS, "request", breakingChange(oldS, newS, "request"));
  assertDirection(result, "request");
  assert.deepEqual(result.sample, { id: 0 });
});

test("request: type narrowing (null|string -> string) uses a dropped type", () => {
  const oldS = infer([{ phone: null }, { phone: "x" }]);
  const newS = infer([{ phone: "x" }]);
  const result = generate(oldS, newS, "request", breakingChange(oldS, newS, "request", "type"));
  assertDirection(result, "request");
  assert.equal(result.sample.phone, null);
  assert.equal(result.newResult.errors[0].path, "/phone");
});

test("request: number narrowed to integer uses a non-integer", () => {
  const oldS = infer([{ age: 1 }, { age: 1.5 }]);
  const newS = infer([{ age: 1 }]);
  const result = generate(oldS, newS, "request", breakingChange(oldS, newS, "request", "type"));
  assertDirection(result, "request");
  assert.equal(Number.isInteger(result.sample.age), false);
});

test("request: newly added items constraint -> old-valid element fails new items", () => {
  const oldS = infer([{ xs: [] }]);
  const newS = infer([{ xs: [1] }]);
  const result = generate(oldS, newS, "request", breakingChange(oldS, newS, "request", "items-added"));
  assertDirection(result, "request");
  assert.equal(Array.isArray(result.sample.xs), true);
  assert.equal(result.sample.xs.length, 1);
  assert.equal(result.newResult.errors[0].path, "/xs/0");
});

test("response: removed required property -> new output lacks it, old rejects", () => {
  const oldS = infer([{ id: 1, name: "a" }]);
  const newS = infer([{ id: 1 }]);
  const result = generate(oldS, newS, "response", breakingChange(oldS, newS, "response"));
  assertDirection(result, "response");
  assert.deepEqual(result.sample, { id: 0 });
  assert.equal(result.oldResult.errors[0].params.missingProperty, "name");
});

test("response: required becoming optional behaves the same way", () => {
  const oldS = infer([{ id: 1, name: "a" }]);
  const newS = infer([{ id: 1, name: "a" }, { id: 2 }]);
  const result = generate(oldS, newS, "response", breakingChange(oldS, newS, "response", "required-removed"));
  assertDirection(result, "response");
  assert.equal(result.sample.name, undefined);
});

test("response: type widening (string -> null|string) uses the gained type", () => {
  const oldS = infer([{ phone: "x" }]);
  const newS = infer([{ phone: null }, { phone: "x" }]);
  const result = generate(oldS, newS, "response", breakingChange(oldS, newS, "response", "type"));
  assertDirection(result, "response");
  assert.equal(result.sample.phone, null);
});

test("response: removed items constraint -> element allowed by new, rejected by old", () => {
  const oldS = infer([{ xs: [1] }]);
  const newS = infer([{ xs: [] }]);
  const result = generate(oldS, newS, "response", breakingChange(oldS, newS, "response", "items-removed"));
  assertDirection(result, "response");
  assert.equal(result.sample.xs.length, 1);
  assert.equal(result.oldResult.errors[0].path, "/xs/0");
});

test("required siblings at the root get valid placeholders", () => {
  const oldS = infer([{ id: 1, phone: null }, { id: 2, phone: "x" }]);
  const newS = infer([{ id: 1, phone: "x" }]);
  const result = generate(oldS, newS, "request", breakingChange(oldS, newS, "request", "type"));
  assertDirection(result, "request");
  assert.deepEqual(result.sample, { id: 0, phone: null });
});

test("required siblings on nested path objects get valid placeholders", () => {
  const oldS = infer([{ meta: { id: 1, tags: ["a"] } }]);
  const newS = infer([{ meta: { id: 1, tags: ["a", 1] } }]);
  // Response breaking: items widened; the sibling meta.id must be present.
  const result = generate(oldS, newS, "response", breakingChange(oldS, newS, "response", "type"));
  assertDirection(result, "response");
  assert.deepEqual(result.sample, { meta: { id: 0, tags: [0] } });
});

test("newly required nested property keeps the parent's other required sibling", () => {
  const oldS = infer([{ user: { name: "a" } }]);
  const newS = infer([{ user: { name: "a", age: 1 } }]);
  const result = generate(oldS, newS, "request", breakingChange(oldS, newS, "request", "property-added"));
  assertDirection(result, "request");
  assert.deepEqual(result.sample, { user: { name: "" } });
});

test("root-level type narrowing replaces the whole document", () => {
  const oldS = infer([1]);
  const newS = infer(["x"]);
  const result = generate(oldS, newS, "request", breakingChange(oldS, newS, "request", "type"));
  assertDirection(result, "request");
  assert.equal(result.sample, 0);
});

test("nested array-of-arrays items type change gets index pointers", () => {
  const oldS = infer([{ matrix: [[1], [2]] }]);
  const newS = infer([{ matrix: [["a"]] }]);
  const result = generate(oldS, newS, "request", breakingChange(oldS, newS, "request", "type"));
  assertDirection(result, "request");
  assert.deepEqual(result.sample, { matrix: [[0]] });
  assert.equal(result.newResult.errors[0].path, "/matrix/0/0");
});

test("errors carry JSON Pointer, keyword, message and params on both sides", () => {
  const oldS = infer([{ phone: null }, { phone: "x" }]);
  const newS = infer([{ phone: "x" }]);
  const result = generate(oldS, newS, "request", breakingChange(oldS, newS, "request", "type"));
  const err = result.newResult.errors[0];
  assert.equal(err.pointer, "/phone");
  assert.equal(err.keyword, "type");
  assert.ok(typeof err.message === "string" && err.message.length > 0);
  assert.ok(err.params && typeof err.params === "object");
  assert.ok(err.schemaPath.startsWith("#/"));
});

test("break cancelled by an enum on the accepting side reports a reason", () => {
  // Old: null|string but the enum only allows "x"; new: string, enum "x".
  // The diff reports a type narrowing (null dropped); null is the only
  // type-discriminating witness, yet the OLD enum forbids null, and every
  // old-legal value ("x") is also new-legal. No isolating witness exists.
  const oldS = {
    type: "object",
    properties: { phone: { type: ["null", "string"], enum: ["x"] } },
    required: ["phone"],
  };
  const newS = {
    type: "object",
    properties: { phone: { type: "string", enum: ["x"] } },
    required: ["phone"],
  };
  const change = compareSchemas(oldS, newS, "request").changes.find((c) => c.kind === "type");
  assert.ok(change, "type change must be reported");
  const result = generateCounterexample({
    oldSchema: oldS,
    newSchema: newS,
    perspective: "request",
    kind: change.kind,
    pointer: change.pointer,
  });
  assert.equal(result.constructible, false);
  assert.ok(result.reason && result.reason.length > 0);
  assert.equal(result.sample, undefined);
});

test("rejects an unsupported change kind with a 400-style error", () => {
  const oldS = infer([{ id: 1 }]);
  const newS = infer([{ id: 1 }]);
  assert.throws(
    () =>
      generateCounterexample({
        oldSchema: oldS,
        newSchema: newS,
        perspective: "request",
        kind: "bogus-kind",
        pointer: "",
      }),
    /暂不支持/
  );
});

test("rejects a malformed pointer", () => {
  const oldS = infer([{ id: 1 }]);
  const newS = infer([{ id: 1 }]);
  assert.throws(
    () =>
      generateCounterexample({
        oldSchema: oldS,
        newSchema: newS,
        perspective: "request",
        kind: "type",
        pointer: "no-leading-slash",
      }),
    /JSON Pointer/
  );
});
