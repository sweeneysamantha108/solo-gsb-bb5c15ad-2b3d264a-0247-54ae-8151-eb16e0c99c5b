"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inferSchema } = require("../infer");
const { buildVariantContract } = require("../variant");
const { buildSlice, MAX_SAMPLES, MAX_POINTERS } = require("../slice");

const ADDRESS_SAMPLES = [
  { id: 1, name: "a", address: { city: "x", zip: "1" } },
  { id: 2, name: "b", address: { city: "y", zip: "2" } },
];

test("buildSlice keeps only the hit properties and intersects required", () => {
  const { schema } = inferSchema(ADDRESS_SAMPLES);
  const out = buildSlice({ schema, samples: ADDRESS_SAMPLES, pointers: ["/properties/name"] });

  assert.equal(out.schema.type, "object");
  assert.deepEqual(Object.keys(out.schema.properties), ["name"]);
  assert.deepEqual(out.schema.properties.name, { type: "string" });
  // id was required too, but only surviving fields stay required.
  assert.deepEqual(out.schema.required, ["name"]);
  assert.equal(out.fieldCount, 1);
  assert.equal(out.sampleCount, 2);
  assert.deepEqual(out.samples, [{ name: "a" }, { name: "b" }]);
  assert.deepEqual(out.pointers, ["/properties/name"]);
  assert.deepEqual(out.ignored, []);
});

test("buildSlice keeps the ancestor structure of a nested selection", () => {
  const { schema } = inferSchema(ADDRESS_SAMPLES);
  const out = buildSlice({
    schema,
    samples: ADDRESS_SAMPLES,
    pointers: ["/properties/address/properties/city"],
  });

  assert.deepEqual(Object.keys(out.schema.properties), ["address"]);
  assert.deepEqual(out.schema.required, ["address"]);
  const address = out.schema.properties.address;
  assert.deepEqual(Object.keys(address.properties), ["city"]);
  assert.deepEqual(address.required, ["city"]);
  assert.equal(out.fieldCount, 2); // address + city
  assert.deepEqual(out.samples, [{ address: { city: "x" } }, { address: { city: "y" } }]);
});

test("buildSlice merges independent selections", () => {
  const samples = [{ a: 1, b: "x", c: true }];
  const { schema } = inferSchema(samples);
  const out = buildSlice({ schema, samples, pointers: ["/properties/c", "/properties/a"] });

  assert.deepEqual(Object.keys(out.schema.properties), ["a", "c"]);
  assert.deepEqual(out.schema.required, ["a", "c"]);
  assert.deepEqual(out.samples, [{ a: 1, c: true }]);
  assert.deepEqual(out.pointers, ["/properties/c", "/properties/a"]);
  assert.equal(out.fieldCount, 2);
});

test("buildSlice ignores pointers covered by a selected ancestor, in any order", () => {
  const { schema } = inferSchema(ADDRESS_SAMPLES);
  for (const pointers of [
    ["/properties/address", "/properties/address/properties/city"],
    ["/properties/address/properties/city", "/properties/address"],
  ]) {
    const out = buildSlice({ schema, samples: ADDRESS_SAMPLES, pointers });
    assert.deepEqual(out.pointers, ["/properties/address"]);
    assert.equal(out.ignored.length, 1);
    assert.equal(out.ignored[0].pointer, "/properties/address/properties/city");
    assert.match(out.ignored[0].reason, /已被祖先/);
    // The ancestor keeps the whole subtree: city AND zip survive.
    assert.deepEqual(Object.keys(out.schema.properties.address.properties), ["city", "zip"]);
    assert.deepEqual(out.samples, ADDRESS_SAMPLES.map((s) => ({ address: s.address })));
  }
});

test("buildSlice ignores duplicate pointers, keeping the first occurrence", () => {
  const { schema } = inferSchema(ADDRESS_SAMPLES);
  const out = buildSlice({
    schema,
    samples: ADDRESS_SAMPLES,
    pointers: ["/properties/name", "/properties/name"],
  });
  assert.deepEqual(out.pointers, ["/properties/name"]);
  assert.equal(out.ignored.length, 1);
  assert.match(out.ignored[0].reason, /重复/);
});

test("buildSlice with the root pointer keeps the whole schema and samples", () => {
  const { schema } = inferSchema(ADDRESS_SAMPLES);
  const out = buildSlice({ schema, samples: ADDRESS_SAMPLES, pointers: [""] });
  assert.deepEqual(out.schema, schema);
  assert.deepEqual(out.samples, ADDRESS_SAMPLES);
  assert.deepEqual(out.pointers, [""]);

  // Everything below the root is covered and ignored.
  const covered = buildSlice({ schema, samples: ADDRESS_SAMPLES, pointers: ["", "/properties/id"] });
  assert.deepEqual(covered.pointers, [""]);
  assert.equal(covered.ignored.length, 1);
  assert.match(covered.ignored[0].reason, /\(root\)/);
});

test("buildSlice recurses along array items", () => {
  const samples = [{ id: 1, tags: ["a", "b"] }, { id: 2, tags: ["c"] }];
  const { schema } = inferSchema(samples);
  const out = buildSlice({ schema, samples, pointers: ["/properties/tags/items"] });

  assert.deepEqual(Object.keys(out.schema.properties), ["tags"]);
  assert.deepEqual(out.schema.required, ["tags"]);
  assert.equal(out.schema.properties.tags.type, "array");
  assert.deepEqual(out.schema.properties.tags.items, { type: "string" });
  assert.equal(out.fieldCount, 1); // items is not a property field
  assert.deepEqual(out.samples, [{ tags: ["a", "b"] }, { tags: ["c"] }]);
});

test("buildSlice slices object fields inside array items", () => {
  const samples = [
    { list: [{ a: 1, b: "x" }, { a: 2, b: "y" }] },
    { list: [{ a: 3, b: "z" }] },
  ];
  const { schema } = inferSchema(samples);
  const out = buildSlice({
    schema,
    samples,
    pointers: ["/properties/list/items/properties/a"],
  });

  const items = out.schema.properties.list.items;
  assert.deepEqual(Object.keys(items.properties), ["a"]);
  assert.deepEqual(items.required, ["a"]);
  assert.equal(out.fieldCount, 2); // list + a
  assert.deepEqual(out.samples, [
    { list: [{ a: 1 }, { a: 2 }] },
    { list: [{ a: 3 }] },
  ]);
});

test("buildSlice keeps heterogeneous array elements that cannot follow the selection verbatim", () => {
  const schema = {
    type: "object",
    properties: {
      list: {
        type: "array",
        items: {
          type: ["null", "object"],
          properties: { a: { type: "integer" } },
          required: ["a"],
        },
      },
    },
    required: ["list"],
  };
  const samples = [{ list: [{ a: 1, b: 2 }, null, { a: 3 }] }];
  const out = buildSlice({ schema, samples, pointers: ["/properties/list/items/properties/a"] });
  assert.deepEqual(out.samples, [{ list: [{ a: 1 }, null, { a: 3 }] }]);
});

test("buildSlice keeps type unions and const unchanged", () => {
  const schema = {
    type: "object",
    properties: {
      kind: { type: "string", const: "created" },
      payload: {
        type: ["null", "object"],
        properties: { a: { type: "integer" } },
        required: ["a"],
      },
    },
    required: ["kind", "payload"],
  };
  const samples = [
    { kind: "created", payload: { a: 1 } },
    { kind: "created", payload: null },
  ];
  const out = buildSlice({
    schema,
    samples,
    pointers: ["/properties/kind", "/properties/payload/properties/a"],
  });

  assert.deepEqual(out.schema.properties.kind, { type: "string", const: "created" });
  assert.deepEqual(out.schema.properties.payload.type, ["null", "object"]);
  assert.deepEqual(Object.keys(out.schema.properties.payload.properties), ["a"]);
  // The null sample keeps the scalar terminal of the ancestor chain.
  assert.deepEqual(out.samples, [
    { kind: "created", payload: { a: 1 } },
    { kind: "created", payload: null },
  ]);
});

test("buildSlice keeps chain terminals verbatim when the sample shape cannot follow the selection", () => {
  const schema = {
    type: "object",
    properties: {
      x: {
        type: ["array", "object"],
        properties: { a: { type: "integer" } },
        items: { type: "string" },
      },
    },
    required: ["x"],
  };
  const samples = [{ x: { a: 1, drop: true } }, { x: ["s1", "s2"] }];

  // Selection walks properties: the array sample is a terminal, kept whole;
  // items is dropped from the slice.
  const viaProps = buildSlice({ schema, samples, pointers: ["/properties/x/properties/a"] });
  assert.deepEqual(viaProps.samples, [{ x: { a: 1 } }, { x: ["s1", "s2"] }]);
  assert.equal(viaProps.schema.properties.x.items, undefined);
  assert.deepEqual(viaProps.schema.properties.x.type, ["array", "object"]);

  // Selection walks items: the object sample is a terminal, kept whole;
  // properties is dropped from the slice.
  const viaItems = buildSlice({ schema, samples, pointers: ["/properties/x/items"] });
  assert.deepEqual(viaItems.samples, [{ x: { a: 1, drop: true } }, { x: ["s1", "s2"] }]);
  assert.equal(viaItems.schema.properties.x.properties, undefined);
  assert.deepEqual(viaItems.schema.properties.x.items, { type: "string" });
});

test("buildSlice supports RFC 6901 escaping in pointers", () => {
  const schema = {
    type: "object",
    properties: { "a/b": { type: "string" }, "c~d": { type: "integer" } },
    required: ["a/b", "c~d"],
  };
  const samples = [{ "a/b": "x", "c~d": 1 }];
  const out = buildSlice({ schema, samples, pointers: ["/properties/a~1b"] });
  assert.deepEqual(out.pointers, ["/properties/a~1b"]);
  assert.deepEqual(Object.keys(out.schema.properties), ["a/b"]);
  assert.deepEqual(out.samples, [{ "a/b": "x" }]);
});

test("buildSlice keeps a __proto__ field with type, required and its projection", () => {
  const samples = [
    JSON.parse(`{"__proto__":"created","id":1}`),
    JSON.parse(`{"__proto__":"deleted","id":2}`),
  ];
  const { schema } = inferSchema(samples);
  const out = buildSlice({ schema, samples, pointers: ["/properties/__proto__"] });

  assert.deepEqual(Object.keys(out.schema.properties), ["__proto__"]);
  assert.deepEqual(out.schema.properties.__proto__, { type: "string" });
  assert.deepEqual(out.schema.required, ["__proto__"]);
  // The Ajv-only alias travels with the surviving field.
  assert.deepEqual(out.schema.patternProperties["^__proto__$"], { type: "string" });
  assert.deepEqual(out.samples, [
    JSON.parse(`{"__proto__":"created"}`),
    JSON.parse(`{"__proto__":"deleted"}`),
  ]);
  // The projected object stays a normal plain object carrying its own key.
  assert.equal(Object.getPrototypeOf(out.samples[0]), Object.prototype);
  assert.ok(Object.prototype.hasOwnProperty.call(out.samples[0], "__proto__"));
});

test("buildSlice keeps a const-pinned __proto__ inside a variant branch", () => {
  const samples = [
    JSON.parse(`{"__proto__":"created","id":1}`),
    JSON.parse(`{"__proto__":"deleted","id":2}`),
  ];
  const { schema } = buildVariantContract({ samples, pointer: "/__proto__" });
  const out = buildSlice({
    schema: schema.oneOf[0],
    samples: [samples[0]],
    pointers: ["/properties/__proto__"],
  });
  assert.deepEqual(out.schema.properties.__proto__, { type: "string", const: "created" });
  assert.deepEqual(out.schema.patternProperties["^__proto__$"], {
    type: "string",
    const: "created",
  });
  assert.deepEqual(out.samples, [JSON.parse(`{"__proto__":"created"}`)]);
});

test("buildSlice projects __proto__ through nested objects and array items", () => {
  const samples = [
    JSON.parse(`{"meta":{"__proto__":"a","keep":1},"list":[{"__proto__":"x","b":2}]}`),
    JSON.parse(`{"meta":{"__proto__":"c","keep":3},"list":[{"__proto__":"y","b":4}]}`),
  ];
  const { schema } = inferSchema(samples);

  const nested = buildSlice({
    schema,
    samples,
    pointers: ["/properties/meta/properties/__proto__"],
  });
  assert.deepEqual(nested.schema.properties.meta.properties.__proto__, { type: "string" });
  assert.deepEqual(nested.schema.properties.meta.required, ["__proto__"]);
  assert.deepEqual(nested.samples, [
    { meta: JSON.parse(`{"__proto__":"a"}`) },
    { meta: JSON.parse(`{"__proto__":"c"}`) },
  ]);

  const items = buildSlice({
    schema,
    samples,
    pointers: ["/properties/list/items/properties/__proto__"],
  });
  assert.deepEqual(items.schema.properties.list.items.properties.__proto__, {
    type: "string",
  });
  assert.deepEqual(items.schema.properties.list.items.required, ["__proto__"]);
  assert.deepEqual(items.samples, [
    { list: [JSON.parse(`{"__proto__":"x"}`)] },
    { list: [JSON.parse(`{"__proto__":"y"}`)] },
  ]);

  // A selected ancestor keeps the whole subtree, alias included.
  const subtree = buildSlice({ schema, samples, pointers: ["/properties/meta"] });
  assert.deepEqual(Object.keys(subtree.schema.properties.meta.properties), [
    "__proto__",
    "keep",
  ]);
  assert.deepEqual(subtree.schema.properties.meta.patternProperties["^__proto__$"], {
    type: "string",
  });
  assert.deepEqual(subtree.samples, [
    { meta: samples[0].meta },
    { meta: samples[1].meta },
  ]);
});

test("buildSlice rejects a wrongly typed projected __proto__ value", () => {
  const { schema } = inferSchema([JSON.parse(`{"__proto__":"a","id":1}`)]);
  assert.throws(
    () =>
      buildSlice({
        schema,
        samples: [JSON.parse(`{"__proto__":123,"id":1}`)],
        pointers: ["/properties/__proto__"],
      }),
    (err) =>
      err.status === 422 &&
      err.details.failures.length === 1 &&
      err.details.failures[0].errors.some((e) => e.keyword === "type")
  );
});

test("buildSlice adds the 2020-12 $schema marker when the input lacks it", () => {
  const out = buildSlice({
    schema: { type: "object", properties: { a: { type: "string" } } },
    samples: [{ a: "x" }],
    pointers: ["/properties/a"],
  });
  assert.equal(out.schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("buildSlice does not mutate the input schema or samples", () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
    },
    required: ["a"],
  };
  const samples = [{ a: { b: "x", c: 1 } }];
  const schemaSnapshot = JSON.parse(JSON.stringify(schema));
  const samplesSnapshot = JSON.parse(JSON.stringify(samples));
  const out = buildSlice({ schema, samples, pointers: ["/properties/a/properties/b"] });
  assert.deepEqual(schema, schemaSnapshot);
  assert.deepEqual(samples, samplesSnapshot);
  // The projected sample is a fresh structure, not a view into the input.
  out.samples[0].a.b = "mutated";
  assert.equal(samples[0].a.b, "x");
});

test("buildSlice refuses with 422 + failing sample indexes when a projection fails validation", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "integer", const: 1 } },
    required: ["a"],
  };
  assert.throws(
    () => buildSlice({ schema, samples: [{ a: 1 }, { a: 2 }, { a: 3 }], pointers: ["/properties/a"] }),
    (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /未产出切片/);
      assert.match(err.message, /#1/);
      assert.equal(err.details.failures.length, 2);
      assert.deepEqual(err.details.failures.map((f) => f.index), [1, 2]);
      assert.equal(err.details.failures[0].errors[0].keyword, "const");
      assert.equal(err.details.failures[0].errors[0].pointer, "/a");
      return true;
    }
  );
});

test("buildSlice refuses when a required field is projected away by the sample shape", () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
    },
    required: ["a"],
  };
  assert.throws(
    () =>
      buildSlice({
        schema,
        samples: [{ a: { b: "x" } }, { a: {} }],
        pointers: ["/properties/a/properties/b"],
      }),
    (err) =>
      err.status === 422 &&
      err.details.failures.length === 1 &&
      err.details.failures[0].index === 1 &&
      err.details.failures[0].errors.some((e) => e.keyword === "required")
  );
});

test("buildSlice refuses illegal and unresolvable pointers with 422 + per-pointer reasons", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  for (const pointer of ["a", "/a~2b", "~0"]) {
    assert.throws(
      () => buildSlice({ schema, samples: [{ a: "x" }], pointers: [pointer] }),
      (err) =>
        err.status === 422 &&
        err.details.invalidPointers.length === 1 &&
        err.details.invalidPointers[0].index === 0 &&
        /Pointer 非法/.test(err.details.invalidPointers[0].reason)
    );
  }
  for (const pointer of ["/properties/missing", "/properties/a/items", "/items", "/properties"]) {
    assert.throws(
      () => buildSlice({ schema, samples: [{ a: "x" }], pointers: [pointer] }),
      (err) =>
        err.status === 422 &&
        err.details.invalidPointers.length === 1 &&
        /未命中/.test(err.details.invalidPointers[0].reason)
    );
  }
  // One bad pointer refuses the run even when the others are fine.
  try {
    buildSlice({ schema, samples: [{ a: "x" }], pointers: ["/properties/a", "/properties/nope"] });
    assert.unreachable("should have thrown");
  } catch (err) {
    assert.equal(err.status, 422);
    assert.equal(err.details.invalidPointers.length, 1);
    assert.equal(err.details.invalidPointers[0].index, 1);
  }
});

test("buildSlice validates its input shape", () => {
  for (const schema of [undefined, null, [], 42, "x"]) {
    assert.throws(
      () => buildSlice({ schema, samples: [{}], pointers: [""] }),
      (err) => err.status === 400 && /'schema' object/.test(err.message)
    );
  }
  for (const samples of [undefined, null, "nope", [], 42]) {
    assert.throws(
      () => buildSlice({ schema: {}, samples, pointers: [""] }),
      (err) => err.status === 400 && /'samples' array/.test(err.message)
    );
  }
  for (const pointers of [undefined, null, "nope", [], 42]) {
    assert.throws(
      () => buildSlice({ schema: {}, samples: [{}], pointers }),
      (err) => err.status === 400 && /'pointers' array/.test(err.message)
    );
  }
  assert.throws(
    () => buildSlice({ schema: {}, samples: [{}], pointers: [42] }),
    (err) => err.status === 400 && /JSON Pointer string/.test(err.message)
  );
});

test(`buildSlice caps samples at ${MAX_SAMPLES} and pointers at ${MAX_POINTERS}`, () => {
  assert.throws(
    () =>
      buildSlice({
        schema: {},
        samples: Array.from({ length: MAX_SAMPLES + 1 }, () => 1),
        pointers: [""],
      }),
    (err) => err.status === 400 && new RegExp(`${MAX_SAMPLES}`).test(err.message)
  );
  assert.throws(
    () =>
      buildSlice({
        schema: {},
        samples: [{}],
        pointers: Array.from({ length: MAX_POINTERS + 1 }, (_, i) => `/p${i}`),
      }),
    (err) => err.status === 400 && new RegExp(`${MAX_POINTERS}`).test(err.message)
  );
  // Exactly at the limits is fine.
  const schema = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: MAX_POINTERS }, (_, i) => [`k${i}`, { type: "integer" }])
    ),
  };
  const ok = buildSlice({
    schema,
    samples: Array.from({ length: MAX_SAMPLES }, () => ({})),
    pointers: Array.from({ length: MAX_POINTERS }, (_, i) => `/properties/k${i}`),
  });
  assert.equal(ok.sampleCount, MAX_SAMPLES);
  assert.equal(ok.pointers.length, MAX_POINTERS);
  assert.equal(ok.fieldCount, MAX_POINTERS);
});
