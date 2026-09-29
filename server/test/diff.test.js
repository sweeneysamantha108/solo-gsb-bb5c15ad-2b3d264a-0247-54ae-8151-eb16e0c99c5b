"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { compareSchemas } = require("../diff");
const { inferSchema } = require("../infer");

function infer(samples) {
  return inferSchema(samples).schema;
}

test("identical schemas produce no changes", () => {
  const schema = infer([{ id: 1, name: "a" }]);
  const { changes, summary } = compareSchemas(schema, schema, "request");
  assert.deepEqual(changes, []);
  assert.deepEqual(summary, { breaking: 0, compatible: 0, info: 0 });
});

test("request: existing field becoming required is breaking; response: compatible", () => {
  const oldS = infer([{ id: 1 }, { id: 2, email: "a@x.com" }]);
  const newS = infer([{ id: 1, email: "a@x.com" }, { id: 2, email: "b@x.com" }]);

  const req = compareSchemas(oldS, newS, "request");
  const change = req.changes.find((c) => c.kind === "required-added");
  assert.ok(change);
  assert.equal(change.pointer, "/properties/email");
  assert.equal(change.field, "email");
  assert.equal(change.severity, "breaking");
  assert.equal(change.oldRule, "可选");
  assert.equal(change.newRule, "必填");
  assert.ok(change.reason.length > 0);

  const res = compareSchemas(oldS, newS, "response");
  assert.equal(res.changes.find((c) => c.kind === "required-added").severity, "compatible");
});

test("request: brand-new required property is breaking; optional one is info", () => {
  const oldS = infer([{ id: 1 }]);
  const newRequired = infer([{ id: 1, email: "a@x.com" }]);
  const added = compareSchemas(oldS, newRequired, "request").changes.find(
    (c) => c.kind === "property-added"
  );
  assert.equal(added.field, "email");
  assert.equal(added.severity, "breaking");
  assert.equal(added.oldRule, "字段不存在");
  assert.match(added.newRule, /必填/);

  const newOptional = infer([{ id: 1, nick: "x" }, { id: 2 }]);
  const info = compareSchemas(oldS, newOptional, "request").changes.find(
    (c) => c.kind === "property-added"
  );
  assert.equal(info.severity, "info");
  assert.match(info.newRule, /可选/);
});

test("response: added property is compatible", () => {
  const oldS = infer([{ id: 1 }]);
  const newS = infer([{ id: 1, email: "a@x.com" }]);
  const added = compareSchemas(oldS, newS, "response").changes.find(
    (c) => c.kind === "property-added"
  );
  assert.equal(added.severity, "compatible");
});

test("response: removed required output is breaking; request: info", () => {
  const oldS = infer([{ id: 1, name: "a" }]);
  const newS = infer([{ id: 1 }]);

  const res = compareSchemas(oldS, newS, "response");
  const removed = res.changes.find((c) => c.kind === "property-removed");
  assert.equal(removed.pointer, "/properties/name");
  assert.equal(removed.severity, "breaking");
  assert.equal(removed.newRule, "字段已移除");
  assert.match(removed.oldRule, /必填/);

  const req = compareSchemas(oldS, newS, "request");
  assert.equal(req.changes.find((c) => c.kind === "property-removed").severity, "info");
});

test("response: removed optional output is only info", () => {
  const oldS = infer([{ id: 1, name: "a" }, { id: 2 }]);
  const newS = infer([{ id: 1 }]);
  const removed = compareSchemas(oldS, newS, "response").changes.find(
    (c) => c.kind === "property-removed"
  );
  assert.equal(removed.severity, "info");
  assert.match(removed.oldRule, /可选/);
});

test("required output becoming optional is breaking for responses", () => {
  const oldS = infer([{ id: 1, name: "a" }]);
  const newS = infer([{ id: 1, name: "a" }, { id: 2 }]);

  const res = compareSchemas(oldS, newS, "response");
  const flip = res.changes.find((c) => c.kind === "required-removed");
  assert.equal(flip.pointer, "/properties/name");
  assert.equal(flip.severity, "breaking");
  assert.equal(flip.oldRule, "必填");
  assert.equal(flip.newRule, "可选");

  const req = compareSchemas(oldS, newS, "request");
  assert.equal(req.changes.find((c) => c.kind === "required-removed").severity, "compatible");
});

test("type narrowing is breaking for requests, compatible for responses", () => {
  const oldS = infer([{ phone: null }, { phone: "123" }]);
  const newS = infer([{ phone: "123" }]);

  const req = compareSchemas(oldS, newS, "request");
  const t = req.changes.find((c) => c.kind === "type");
  assert.equal(t.pointer, "/properties/phone");
  assert.equal(t.severity, "breaking");
  assert.equal(t.oldRule, "类型：null | string");
  assert.equal(t.newRule, "类型：string");
  assert.match(t.reason, /收窄/);

  const res = compareSchemas(oldS, newS, "response");
  assert.equal(res.changes.find((c) => c.kind === "type").severity, "compatible");
});

test("type widening is breaking for responses, compatible for requests", () => {
  const oldS = infer([{ phone: "123" }]);
  const newS = infer([{ phone: null }, { phone: "123" }]);

  const res = compareSchemas(oldS, newS, "response");
  const t = res.changes.find((c) => c.kind === "type");
  assert.equal(t.severity, "breaking");
  assert.equal(t.oldRule, "类型：string");
  assert.equal(t.newRule, "类型：null | string");
  assert.match(t.reason, /放宽/);

  const req = compareSchemas(oldS, newS, "request");
  assert.equal(req.changes.find((c) => c.kind === "type").severity, "compatible");
});

test("integer <-> number follows widening/narrowing semantics", () => {
  const intS = infer([{ age: 30 }]);
  const numS = infer([{ age: 30 }, { age: 25.5 }]);

  // integer -> number widens: breaking for responses, compatible for requests.
  const widened = compareSchemas(intS, numS, "response");
  assert.equal(widened.changes.find((c) => c.kind === "type").severity, "breaking");
  const widenedReq = compareSchemas(intS, numS, "request");
  assert.equal(widenedReq.changes.find((c) => c.kind === "type").severity, "compatible");

  // number -> integer narrows: breaking for requests.
  const narrowed = compareSchemas(numS, intS, "request");
  assert.equal(narrowed.changes.find((c) => c.kind === "type").severity, "breaking");
});

test("nested object changes carry full JSON Pointers", () => {
  const oldS = infer([{ user: { name: "a" } }]);
  const newS = infer([{ user: { name: "a", age: 1 } }]);
  const added = compareSchemas(oldS, newS, "request").changes.find(
    (c) => c.kind === "property-added"
  );
  assert.equal(added.pointer, "/properties/user/properties/age");
});

test("array items recurse with the /items pointer", () => {
  const oldS = infer([{ tags: ["a"] }]);
  const newS = infer([{ tags: ["a", 1] }]);
  const res = compareSchemas(oldS, newS, "response");
  const t = res.changes.find((c) => c.kind === "type");
  assert.equal(t.pointer, "/properties/tags/items");
  assert.equal(t.severity, "breaking");
});

test("items constraint added is breaking for requests; removed is breaking for responses", () => {
  const unconstrained = infer([{ xs: [] }]);
  const constrained = infer([{ xs: [1] }]);

  const req = compareSchemas(unconstrained, constrained, "request");
  const added = req.changes.find((c) => c.kind === "items-added");
  assert.equal(added.pointer, "/properties/xs/items");
  assert.equal(added.severity, "breaking");
  assert.equal(added.oldRule, "items：无约束（任意元素）");

  const res = compareSchemas(constrained, unconstrained, "response");
  const removed = res.changes.find((c) => c.kind === "items-removed");
  assert.equal(removed.pointer, "/properties/xs/items");
  assert.equal(removed.severity, "breaking");
  assert.equal(removed.newRule, "items：无约束（任意元素）");
});

test("keys needing JSON Pointer escaping are escaped in change pointers", () => {
  const oldS = infer([{ "a/b": 1 }]);
  const newS = infer([{ "a/b": "x" }]);
  const t = compareSchemas(oldS, newS, "request").changes.find((c) => c.kind === "type");
  assert.equal(t.pointer, "/properties/a~1b");
});

test("changes are sorted by pointer and summary counts severities", () => {
  const oldS = infer([{ a: 1, b: "x" }]);
  const newS = infer([{ a: "s" }]);
  const { changes, summary } = compareSchemas(oldS, newS, "response");
  assert.ok(changes.length >= 2);
  const pointers = changes.map((c) => c.pointer);
  assert.deepEqual(pointers, [...pointers].sort());
  assert.equal(summary.breaking + summary.compatible + summary.info, changes.length);
  assert.equal(summary.breaking, changes.filter((c) => c.severity === "breaking").length);
});

test("rejects an unknown perspective", () => {
  assert.throws(() => compareSchemas({}, {}, "sideways"), TypeError);
});
