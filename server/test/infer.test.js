"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv2020 = require("ajv/dist/2020").default;
const { inferSchema } = require("../infer");

const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });

test("single object sample: types and required keys", () => {
  const { schema, paths } = inferSchema([{ id: 1, name: "Alice" }]);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["id", "name"]);
  assert.equal(schema.properties.id.type, "integer");
  assert.equal(schema.properties.name.type, "string");
  assert.deepEqual(paths[""], ["#/0"]);
  assert.deepEqual(paths["/properties/name"], ["#/0/name"]);
});

test("missing field in one sample becomes optional", () => {
  const { schema } = inferSchema([
    { id: 1, email: "a@x.com" },
    { id: 2 },
  ]);
  assert.deepEqual(schema.required, ["id"]);
  assert.equal(schema.properties.email.type, "string");
});

test("null merges into a type union", () => {
  const { schema } = inferSchema([{ phone: null }, { phone: "123" }]);
  assert.deepEqual(schema.properties.phone.type, ["null", "string"]);
});

test("integer widened to number when floats appear", () => {
  const { schema } = inferSchema([{ age: 30 }, { age: 25.5 }]);
  assert.equal(schema.properties.age.type, "number");
});

test("heterogeneous array items fold into one items schema", () => {
  const { schema, paths } = inferSchema([{ tags: ["a", 1, null] }]);
  assert.deepEqual(schema.properties.tags.items.type, ["null", "integer", "string"]);
  assert.deepEqual(paths["/properties/tags/items"], ["#/0/tags/0", "#/0/tags/1", "#/0/tags/2"]);
});

test("array items merge across samples", () => {
  const { schema } = inferSchema([{ xs: [1, 2] }, { xs: ["s"] }]);
  assert.deepEqual(schema.properties.xs.items.type, ["integer", "string"]);
});

test("type conflict between object and scalar yields a union", () => {
  const { schema } = inferSchema([{ meta: { a: 1 } }, { meta: "raw" }]);
  assert.deepEqual(schema.properties.meta.type, ["string", "object"]);
  assert.equal(schema.properties.meta.properties.a.type, "integer");
  // `required` only considers object observations.
  assert.deepEqual(schema.properties.meta.required, ["a"]);
});

test("nested objects record full sample pointers", () => {
  const { paths } = inferSchema([
    { address: { city: "Shanghai" } },
    { address: { city: "Beijing" } },
  ]);
  assert.deepEqual(paths["/properties/address/properties/city"], [
    "#/0/address/city",
    "#/1/address/city",
  ]);
});

test("empty arrays leave items unconstrained", () => {
  const { schema } = inferSchema([{ xs: [] }, { xs: [] }]);
  assert.equal(schema.properties.xs.type, "array");
  assert.equal(schema.properties.xs.items, undefined);
});

test("root-level arrays and scalars are supported", () => {
  const arr = inferSchema([[1], [2, 3]]);
  assert.equal(arr.schema.type, "array");
  assert.equal(arr.schema.items.type, "integer");
  const scal = inferSchema(["a", "b"]);
  assert.equal(scal.schema.type, "string");
});

test("keys needing JSON Pointer escaping are escaped in sample paths", () => {
  const { paths } = inferSchema([{ "a/b": 1 }]);
  assert.deepEqual(paths["/properties/a~1b"], ["#/0/a~1b"]);
});

test("__proto__ is kept as a normal property with its type and required rule", () => {
  // JSON.parse (like the HTTP body parser) stores "__proto__" as an own key.
  const samples = [
    JSON.parse(`{"__proto__":"created","id":1}`),
    JSON.parse(`{"__proto__":"deleted","id":2}`),
  ];
  const { schema, paths } = inferSchema(samples);

  assert.deepEqual(schema.required, ["__proto__", "id"]);
  assert.deepEqual(Object.keys(schema.properties), ["__proto__", "id"]);
  assert.equal(schema.properties.__proto__.type, "string");
  assert.ok(Object.prototype.hasOwnProperty.call(schema.properties, "__proto__"));
  assert.deepEqual(schema.properties.__proto__, { type: "string" });
  assert.deepEqual(paths["/properties/__proto__"], ["#/0/__proto__", "#/1/__proto__"]);
  // The schema serializes the field like any other key.
  const reparsed = JSON.parse(JSON.stringify(schema));
  assert.deepEqual(reparsed.properties.__proto__, { type: "string" });

  // Ajv enforces the type (via the patternProperties alias) and requiredness.
  const validate = ajv.compile(schema);
  assert.equal(validate(samples[0]), true);
  assert.equal(validate(samples[1]), true);
  assert.equal(validate(JSON.parse(`{"__proto__":123,"id":3}`)), false);
  assert.equal(validate(JSON.parse(`{"id":3}`)), false);
  // Extra unknown keys stay allowed, as for any other property.
  assert.equal(validate(JSON.parse(`{"__proto__":"created","id":1,"x":9}`)), true);
});

test("__proto__ works inside nested objects and array elements", () => {
  const { schema } = inferSchema([
    JSON.parse(`{"meta":{"__proto__":1},"list":[{"__proto__":"a"}]}`),
    JSON.parse(`{"meta":{"__proto__":2},"list":[{"__proto__":"b"}]}`),
  ]);
  assert.equal(schema.properties.meta.properties.__proto__.type, "integer");
  assert.deepEqual(schema.properties.meta.required, ["__proto__"]);
  assert.equal(schema.properties.list.items.properties.__proto__.type, "string");
  assert.deepEqual(schema.properties.list.items.required, ["__proto__"]);

  const validate = ajv.compile(schema);
  assert.equal(
    validate(JSON.parse(`{"meta":{"__proto__":3},"list":[{"__proto__":"c"}]}`)),
    true
  );
  assert.equal(
    validate(JSON.parse(`{"meta":{"__proto__":"nope"},"list":[]}`)),
    false
  );
  assert.equal(
    validate(JSON.parse(`{"meta":{"__proto__":3},"list":[{"__proto__":1}]}`)),
    false
  );
});

test("__proto__ missing in one sample becomes optional, like any field", () => {
  const { schema } = inferSchema([
    JSON.parse(`{"__proto__":"a","id":1}`),
    JSON.parse(`{"id":2}`),
  ]);
  assert.deepEqual(schema.required, ["id"]);
  assert.equal(schema.properties.__proto__.type, "string");
  const validate = ajv.compile(schema);
  assert.equal(validate(JSON.parse(`{"id":2}`)), true);
  assert.equal(validate(JSON.parse(`{"id":3,"__proto__":"b"}`)), true);
});

test("inference never pollutes Object.prototype through __proto__", () => {
  inferSchema([JSON.parse(`{"__proto__":{"polluted":"yes"}}`)]);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test("rejects empty sample list", () => {
  assert.throws(() => inferSchema([]), TypeError);
});
