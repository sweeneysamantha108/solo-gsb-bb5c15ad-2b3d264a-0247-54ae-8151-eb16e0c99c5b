"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv2020 = require("ajv/dist/2020").default;
const { buildVariantContract, parsePointer, MAX_SAMPLES } = require("../variant");
const { createApp } = require("../app");

const EVENT_SAMPLES = [
  { type: "created", id: 1, payload: { a: 1 } },
  { type: "created", id: 2 },
  { type: "deleted", id: 3, reason: "cleanup" },
];

test("parsePointer unescapes RFC 6901 segments and rejects illegal escapes", () => {
  assert.deepEqual(parsePointer(""), []);
  assert.deepEqual(parsePointer("/type"), ["type"]);
  assert.deepEqual(parsePointer("/meta/event"), ["meta", "event"]);
  assert.deepEqual(parsePointer("/a~0b"), ["a~b"]);
  assert.deepEqual(parsePointer("/a~1b"), ["a/b"]);
  assert.deepEqual(parsePointer("/~0~1"), ["~/"]);
  // Illegal: no leading slash, dangling or unknown "~" escapes, non-string.
  assert.equal(parsePointer("type"), null);
  assert.equal(parsePointer("/a~2b"), null);
  assert.equal(parsePointer("/a~"), null);
  assert.equal(parsePointer("/~"), null);
  assert.equal(parsePointer(42), null);
  assert.equal(parsePointer(undefined), null);
});

test("groups by a string discriminator and builds oneOf branches with const", () => {
  const result = buildVariantContract({ samples: EVENT_SAMPLES, pointer: "/type" });
  assert.equal(result.pointer, "/type");
  assert.equal(result.totalSamples, 3);
  assert.equal(result.validSamples, 3);
  assert.equal(result.groupCount, 2);
  assert.deepEqual(result.skipped, []);

  const { schema } = result;
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.oneOf.length, 2);

  // Branch order follows first appearance of each discriminator value.
  const [created, deleted] = schema.oneOf;
  assert.equal(created.properties.type.const, "created");
  assert.equal(deleted.properties.type.const, "deleted");
  // Only fields shared by every sample of the group are required.
  assert.deepEqual([...created.required].sort(), ["id", "type"]);
  assert.deepEqual([...deleted.required].sort(), ["id", "reason", "type"]);
  // Optional-in-group fields stay optional but remain in properties.
  assert.ok(created.properties.payload);
  assert.ok(!created.required.includes("payload"));
  // Branches carry no $schema marker; the top-level contract does.
  assert.equal(created.$schema, undefined);

  // Group metadata lines up with the branches.
  assert.deepEqual(
    result.groups.map((g) => [g.value, g.count, g.sampleIndexes]),
    [
      ["created", 2, [0, 1]],
      ["deleted", 1, [2]],
    ]
  );
  assert.equal(result.groups[0].schema, schema.oneOf[0]);
});

test("number and boolean discriminators stay type-distinct groups", () => {
  const { schema, groupCount } = buildVariantContract({
    pointer: "/code",
    samples: [{ code: 1 }, { code: 1.5 }, { code: true }, { code: "1" }],
  });
  assert.equal(groupCount, 4);
  assert.deepEqual(
    schema.oneOf.map((b) => b.properties.code.const),
    [1, 1.5, true, "1"]
  );
  // The inferred scalar type is kept next to the const pin.
  assert.equal(schema.oneOf[0].properties.code.type, "integer");
  assert.equal(schema.oneOf[1].properties.code.type, "number");
  assert.equal(schema.oneOf[2].properties.code.type, "boolean");
});

test("missing fields and object/array/null values are skipped with reasons", () => {
  const result = buildVariantContract({
    pointer: "/type",
    samples: [
      { type: "a" },
      { id: 1 }, // missing discriminator
      { type: null },
      { type: { nested: 1 } },
      { type: ["x"] },
      { type: "b" },
    ],
  });
  assert.equal(result.groupCount, 2);
  assert.equal(result.validSamples, 2);
  assert.deepEqual(
    result.skipped.map((s) => s.index),
    [1, 2, 3, 4]
  );
  assert.match(result.skipped[0].reason, /缺失/);
  assert.match(result.skipped[1].reason, /null/);
  assert.match(result.skipped[2].reason, /对象/);
  assert.match(result.skipped[3].reason, /数组/);
});

test("a sample that is not an object at all reports the field as missing", () => {
  const result = buildVariantContract({
    pointer: "/type",
    samples: [{ type: "a" }, "scalar", [1, 2], { type: "b" }],
  });
  assert.equal(result.groupCount, 2);
  assert.deepEqual(
    result.skipped.map((s) => s.index),
    [1, 2]
  );
  for (const skip of result.skipped) assert.match(skip.reason, /缺失/);
});

test("nested pointers pin const at the nested path and require every level", () => {
  const { schema } = buildVariantContract({
    pointer: "/meta/event",
    samples: [
      { meta: { event: "a", v: 1 }, id: 1 },
      { meta: { event: "b", v: 2 }, id: 2 },
    ],
  });
  const [branchA, branchB] = schema.oneOf;
  assert.equal(branchA.properties.meta.properties.event.const, "a");
  assert.equal(branchB.properties.meta.properties.event.const, "b");
  assert.ok(branchA.required.includes("meta"));
  assert.ok(branchA.properties.meta.required.includes("event"));
  assert.ok(branchA.properties.meta.required.includes("v"));
});

test("escaped pointer segments address keys containing ~ and /", () => {
  const { schema, groupCount, skipped } = buildVariantContract({
    pointer: "/a~0b/c~1d",
    samples: [
      { "a~b": { "c/d": "x" }, id: 1 },
      { "a~b": { "c/d": "y" }, id: 2 },
    ],
  });
  assert.equal(groupCount, 2);
  assert.deepEqual(skipped, []);
  assert.equal(schema.oneOf[0].properties["a~b"].properties["c/d"].const, "x");
  assert.equal(schema.oneOf[1].properties["a~b"].properties["c/d"].const, "y");
});

test("a __proto__ discriminator keeps the const pin on every branch", () => {
  const samples = [
    JSON.parse(`{"__proto__":"created","id":1}`),
    JSON.parse(`{"__proto__":"created","id":2}`),
    JSON.parse(`{"__proto__":"deleted","id":3}`),
  ];
  const result = buildVariantContract({ samples, pointer: "/__proto__" });
  assert.equal(result.groupCount, 2);
  assert.deepEqual(result.skipped, []);

  const [created, deleted] = result.schema.oneOf;
  assert.equal(created.properties.__proto__.const, "created");
  assert.equal(deleted.properties.__proto__.const, "deleted");
  assert.ok(created.required.includes("__proto__"));
  // Ajv enforces the pin through the patternProperties alias; without it both
  // branches would match every sample and oneOf would reject them all.
  assert.equal(created.patternProperties["^__proto__$"].const, "created");
  assert.equal(deleted.patternProperties["^__proto__$"].const, "deleted");

  const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });
  const validate = ajv.compile(result.schema);
  assert.equal(validate(samples[0]), true);
  assert.equal(validate(samples[1]), true);
  assert.equal(validate(samples[2]), true);
  assert.equal(validate(JSON.parse(`{"__proto__":"renamed","id":9}`)), false);
  assert.equal(validate(JSON.parse(`{"id":9}`)), false);
});

test("a nested __proto__ discriminator pins const along the path", () => {
  const samples = [
    JSON.parse(`{"meta":{"__proto__":"a","v":1},"id":1}`),
    JSON.parse(`{"meta":{"__proto__":"b","v":2},"id":2}`),
  ];
  const { schema } = buildVariantContract({ samples, pointer: "/meta/__proto__" });
  assert.equal(schema.oneOf[0].properties.meta.properties.__proto__.const, "a");
  assert.equal(
    schema.oneOf[0].properties.meta.patternProperties["^__proto__$"].const,
    "a"
  );
  assert.ok(schema.oneOf[0].properties.meta.required.includes("__proto__"));
  const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(samples[0]), true);
  assert.equal(validate(samples[1]), true);
  assert.equal(
    validate(JSON.parse(`{"meta":{"__proto__":"nope","v":1},"id":1}`)),
    false
  );
});

test("branches keep the inferred type of __proto__ fields inside array items", () => {
  const samples = [
    JSON.parse(`{"type":"a","events":[{"__proto__":"on","n":1}]}`),
    JSON.parse(`{"type":"b","events":[{"__proto__":"off","n":2}]}`),
  ];
  const { schema } = buildVariantContract({ samples, pointer: "/type" });
  const itemProps = schema.oneOf[0].properties.events.items.properties;
  assert.equal(itemProps.__proto__.type, "string");
  assert.deepEqual(schema.oneOf[0].properties.events.items.required, ["__proto__", "n"]);
  const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(samples[0]), true);
  assert.equal(validate(samples[1]), true);
  assert.equal(
    validate(JSON.parse(`{"type":"a","events":[{"__proto__":1,"n":1}]}`)),
    false
  );
});

test("the empty pointer addresses the root (scalar samples)", () => {
  const { schema, groupCount } = buildVariantContract({
    pointer: "",
    samples: ["a", "a", "b"],
  });
  assert.equal(groupCount, 2);
  assert.deepEqual(
    schema.oneOf.map((b) => b.const),
    ["a", "b"]
  );
});

test("an illegal pointer skips every sample and refuses with 422 + details", () => {
  for (const pointer of ["no-slash", "/a~2b", "/~"]) {
    assert.throws(
      () => buildVariantContract({ samples: [{ a: 1 }, { a: 2 }], pointer }),
      (err) => {
        assert.equal(err.status, 422);
        assert.match(err.message, /Pointer 非法/);
        assert.equal(err.details.groupCount, 0);
        assert.equal(err.details.validSamples, 0);
        assert.equal(err.details.totalSamples, 2);
        assert.equal(err.details.skipped.length, 2);
        assert.deepEqual(
          err.details.skipped.map((s) => s.index),
          [0, 1]
        );
        for (const skip of err.details.skipped) assert.match(skip.reason, /Pointer 非法/);
        assert.deepEqual(err.details.groups, []);
        return true;
      }
    );
  }
});

test("fewer than two valid groups refuses with 422 and grouping details", () => {
  // Exactly one group.
  assert.throws(
    () =>
      buildVariantContract({
        pointer: "/type",
        samples: [{ type: "a" }, { type: "a" }, { type: "a" }],
      }),
    (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /不足 2 个/);
      assert.equal(err.details.groupCount, 1);
      assert.deepEqual(err.details.groups, [
        { value: "a", count: 3, sampleIndexes: [0, 1, 2] },
      ]);
      assert.deepEqual(err.details.skipped, []);
      return true;
    }
  );
  // Zero valid samples.
  assert.throws(
    () => buildVariantContract({ pointer: "/type", samples: [{ x: 1 }, { type: null }] }),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.details.groupCount, 0);
      assert.equal(err.details.skipped.length, 2);
      return true;
    }
  );
});

test("input shape is validated with status 400", () => {
  for (const samples of [undefined, null, "nope", { 0: 1 }, []]) {
    assert.throws(
      () => buildVariantContract({ samples, pointer: "/type" }),
      (err) => err.status === 400 && /'samples' array/.test(err.message)
    );
  }
  assert.throws(
    () => buildVariantContract({ samples: [{ a: 1 }] }),
    (err) => err.status === 400 && /'pointer' string/.test(err.message)
  );
  assert.throws(
    () =>
      buildVariantContract({
        samples: Array.from({ length: MAX_SAMPLES + 1 }, (_, i) => ({ type: i })),
        pointer: "/type",
      }),
    (err) => err.status === 400 && new RegExp(`${MAX_SAMPLES}`).test(err.message)
  );
});

test("path map entries are remapped to global sample indexes", () => {
  const { groups } = buildVariantContract({
    pointer: "/type",
    samples: [
      { skip: true }, // skipped, global #0
      { type: "a", k: 1 }, // group-local #0, global #1
      { type: "a", k: 2 }, // group-local #1, global #2
      { type: "b", k: 3 }, // group-local #0, global #3
    ],
  });
  assert.deepEqual([...groups[0].paths[""]].sort(), ["#/1", "#/2"]);
  assert.deepEqual([...groups[0].paths["/properties/k"]].sort(), ["#/1/k", "#/2/k"]);
  assert.deepEqual(groups[1].paths[""], ["#/3"]);
});

test("the generated contract accepts its own samples and rejects drift", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const { schema } = buildVariantContract({ samples: EVENT_SAMPLES, pointer: "/type" });
  const validate = ajv.compile(schema);
  // Every participating sample matches exactly one branch (oneOf semantics).
  for (const sample of EVENT_SAMPLES) {
    assert.equal(validate(sample), true, JSON.stringify(validate.errors));
  }
  // Unknown discriminator value: no branch matches.
  assert.equal(validate({ type: "renamed", id: 9 }), false);
  // Missing discriminator: every branch requires it.
  assert.equal(validate({ id: 9 }), false);
  // Missing a field that is required within its group.
  assert.equal(validate({ type: "deleted", id: 4 }), false);
});

/* ------------------------------ HTTP route ------------------------------ */

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function post(pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test("POST /api/variant returns a oneOf contract with grouping metadata", async () => {
  const { status, data } = await post("/api/variant", {
    samples: EVENT_SAMPLES,
    pointer: "/type",
  });
  assert.equal(status, 200);
  assert.equal(data.groupCount, 2);
  assert.equal(data.validSamples, 3);
  assert.equal(data.totalSamples, 3);
  assert.equal(data.schema.oneOf.length, 2);
  assert.equal(data.schema.oneOf[0].properties.type.const, "created");
  assert.deepEqual(data.skipped, []);
  assert.equal(data.groups[1].value, "deleted");
  assert.deepEqual(data.groups[1].sampleIndexes, [2]);
});

test("POST /api/variant 422 response carries skip reasons and group summaries", async () => {
  const { status, data } = await post("/api/variant", {
    samples: [{ type: "a" }, { id: 1 }, { type: { x: 1 } }],
    pointer: "/type",
  });
  assert.equal(status, 422);
  assert.match(data.error, /不足 2 个/);
  assert.equal(data.groupCount, 1);
  assert.deepEqual(data.groups, [{ value: "a", count: 1, sampleIndexes: [0] }]);
  assert.deepEqual(
    data.skipped.map((s) => s.index),
    [1, 2]
  );
  assert.match(data.skipped[0].reason, /缺失/);
  assert.match(data.skipped[1].reason, /对象/);
});

test("POST /api/variant rejects an illegal pointer with per-sample reasons", async () => {
  const { status, data } = await post("/api/variant", {
    samples: [{ a: 1 }, { a: 2 }],
    pointer: "/a~9b",
  });
  assert.equal(status, 422);
  assert.match(data.error, /Pointer 非法/);
  assert.equal(data.skipped.length, 2);
  assert.match(data.skipped[0].reason, /Pointer 非法/);
});

test("POST /api/variant validates its input", async () => {
  const missingSamples = await post("/api/variant", { pointer: "/type" });
  assert.equal(missingSamples.status, 400);
  assert.match(missingSamples.data.error, /'samples' array/);

  const missingPointer = await post("/api/variant", { samples: [{ a: 1 }] });
  assert.equal(missingPointer.status, 400);
  assert.match(missingPointer.data.error, /'pointer' string/);

  const tooMany = await post("/api/variant", {
    samples: Array.from({ length: 201 }, (_, i) => ({ type: i })),
    pointer: "/type",
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /200/);
});
