"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");
const { makeRuleId } = require("../relation");

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

test("GET /api/health", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("POST /api/infer returns schema, paths and count", async () => {
  const { status, data } = await post("/api/infer", {
    samples: [{ id: 1, tag: "x" }, { id: 2 }],
  });
  assert.equal(status, 200);
  assert.equal(data.sampleCount, 2);
  assert.equal(data.schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(data.schema.required, ["id"]);
  assert.equal(typeof data.paths, "object");
});

test("POST /api/infer rejects missing samples", async () => {
  const { status, data } = await post("/api/infer", { samples: [] });
  assert.equal(status, 400);
  assert.match(data.error, /samples/);
});

test("POST /api/validate reports JSON Pointers for errors", async () => {
  const { data: inferred } = await post("/api/infer", {
    samples: [{ id: 1, user: { name: "a" } }],
  });
  const ok = await post("/api/validate", {
    schema: inferred.schema,
    sample: { id: 2, user: { name: "b" } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.valid, true);
  assert.deepEqual(ok.data.errors, []);

  const bad = await post("/api/validate", {
    schema: inferred.schema,
    sample: { id: "oops", user: {} },
  });
  assert.equal(bad.data.valid, false);
  const paths = bad.data.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ["/id", "/user"]);
  const idErr = bad.data.errors.find((e) => e.path === "/id");
  assert.equal(idErr.keyword, "type");
  assert.equal(idErr.pointer, "/id");
});

test("POST /api/validate rejects an invalid schema", async () => {
  const { status, data } = await post("/api/validate", {
    schema: { type: "not-a-type" },
    sample: 1,
  });
  assert.equal(status, 422);
  assert.match(data.error, /Invalid schema/);
});

test("POST /api/hotspots clusters errors by rule and splits by property params", async () => {
  const schema = {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["id", "name"],
    additionalProperties: false,
  };
  const { status, data } = await post("/api/hotspots", {
    schema,
    samples: [
      { id: "x", tags: ["a", 1], extra: true }, // id type, item type, name, extra
      { id: 1, name: "ok", tags: ["a"] }, // valid
      { id: 2, tags: [2, 3], oops: 1 }, // 2 item errors, name, oops
    ],
  });
  assert.equal(status, 200);
  assert.equal(data.total, 3);
  assert.equal(data.validCount, 1);
  assert.equal(data.invalidCount, 2);
  assert.equal(data.errorCount, 8);
  assert.equal(data.clusterCount, 5);

  // Sorted by affected-sample count descending: the shared "name" required
  // violation and the items/type rule both touch 2 samples and lead.
  const [first, second] = data.clusters;
  assert.equal(first.sampleCount, 2);
  assert.equal(second.sampleCount, 2);
  const leaders = [first, second];
  const nameCluster = leaders.find((c) => c.keyword === "required");
  assert.equal(nameCluster.missingProperty, "name");
  assert.equal(nameCluster.errorCount, 2);
  assert.deepEqual(nameCluster.sampleIndexes, [0, 2]);
  const itemsCluster = leaders.find((c) => c.keyword === "type");
  assert.equal(itemsCluster.schemaPath, "#/properties/tags/items/type");
  assert.equal(itemsCluster.errorCount, 3);
  assert.deepEqual(
    itemsCluster.occurrences.map((o) => [o.index, o.pointer]),
    [
      [0, "/tags/1"],
      [2, "/tags/0"],
      [2, "/tags/1"],
    ]
  );

  // required splits per missingProperty, additionalProperties per property.
  const idCluster = data.clusters.find((c) => c.schemaPath === "#/properties/id/type");
  assert.equal(idCluster.sampleCount, 1);
  assert.deepEqual(idCluster.sampleIndexes, [0]);
  const extraProps = data.clusters
    .filter((c) => c.keyword === "additionalProperties")
    .map((c) => c.additionalProperty)
    .sort();
  assert.deepEqual(extraProps, ["extra", "oops"]);
});

test("POST /api/hotspots validates its input", async () => {
  const noSchema = await post("/api/hotspots", { samples: [] });
  assert.equal(noSchema.status, 400);
  assert.match(noSchema.data.error, /'schema' object/);

  const noSamples = await post("/api/hotspots", { schema: {} });
  assert.equal(noSamples.status, 400);
  assert.match(noSamples.data.error, /'samples' array/);

  const tooMany = await post("/api/hotspots", {
    schema: {},
    samples: Array.from({ length: 201 }, () => 1),
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /200/);

  const atLimit = await post("/api/hotspots", {
    schema: { type: "integer" },
    samples: Array.from({ length: 200 }, () => 1),
  });
  assert.equal(atLimit.status, 200);
  assert.equal(atLimit.data.total, 200);
  assert.equal(atLimit.data.validCount, 200);
  assert.equal(atLimit.data.clusterCount, 0);

  const invalidSchema = await post("/api/hotspots", {
    schema: { type: "not-a-type" },
    samples: [1],
  });
  assert.equal(invalidSchema.status, 422);
  assert.match(invalidSchema.data.error, /Invalid schema/);
});

test("POST /api/diff classifies changes per perspective", async () => {
  const oldS = (
    await post("/api/infer", { samples: [{ id: 1, name: "a" }] })
  ).data.schema;
  const newS = (await post("/api/infer", { samples: [{ id: 1 }] })).data.schema;

  const res = await post("/api/diff", { oldSchema: oldS, newSchema: newS, perspective: "response" });
  assert.equal(res.status, 200);
  assert.equal(res.data.perspective, "response");
  const removed = res.data.changes.find((c) => c.kind === "property-removed");
  assert.equal(removed.pointer, "/properties/name");
  assert.equal(removed.severity, "breaking");
  assert.equal(res.data.summary.breaking, 1);
  assert.ok(removed.oldRule && removed.newRule && removed.reason);

  const req = await post("/api/diff", { oldSchema: oldS, newSchema: newS, perspective: "request" });
  assert.equal(req.data.changes.find((c) => c.kind === "property-removed").severity, "info");
  assert.equal(req.data.summary.breaking, 0);
});

test("POST /api/diff defaults to the request perspective", async () => {
  const { status, data } = await post("/api/diff", { oldSchema: {}, newSchema: {} });
  assert.equal(status, 200);
  assert.equal(data.perspective, "request");
  assert.deepEqual(data.changes, []);
  assert.deepEqual(data.summary, { breaking: 0, compatible: 0, info: 0 });
});

test("POST /api/diff validates its input", async () => {
  const missing = await post("/api/diff", { oldSchema: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /newSchema/);

  const badPerspective = await post("/api/diff", {
    oldSchema: {},
    newSchema: {},
    perspective: "sideways",
  });
  assert.equal(badPerspective.status, 400);
  assert.match(badPerspective.data.error, /perspective/);
});

test("POST /api/counterexample builds a request witness verified on both sides", async () => {
  const oldS = (
    await post("/api/infer", { samples: [{ id: 1, phone: null }, { id: 2, phone: "x" }] })
  ).data.schema;
  const newS = (await post("/api/infer", { samples: [{ id: 1, phone: "x" }] })).data.schema;

  const res = await post("/api/counterexample", {
    oldSchema: oldS,
    newSchema: newS,
    perspective: "request",
    kind: "type",
    pointer: "/properties/phone",
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.constructible, true);
  assert.equal(res.data.perspective, "request");
  assert.deepEqual(res.data.sample, { id: 0, phone: null });
  assert.equal(res.data.oldResult.valid, true);
  assert.deepEqual(res.data.oldResult.errors, []);
  assert.equal(res.data.newResult.valid, false);
  assert.ok(res.data.newResult.errors.length > 0);
  assert.equal(res.data.newResult.errors[0].pointer, "/phone");
});

test("POST /api/counterexample covers response direction and items changes", async () => {
  const oldS = (await post("/api/infer", { samples: [{ xs: [1] }] })).data.schema;
  const newS = (await post("/api/infer", { samples: [{ xs: [] }] })).data.schema;
  const res = await post("/api/counterexample", {
    oldSchema: oldS,
    newSchema: newS,
    perspective: "response",
    kind: "items-removed",
    pointer: "/properties/xs/items",
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.constructible, true);
  assert.equal(res.data.newResult.valid, true);
  assert.equal(res.data.oldResult.valid, false);
  assert.equal(res.data.oldResult.errors[0].path, "/xs/0");
});

test("POST /api/counterexample returns a reason when no witness exists", async () => {
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
  const res = await post("/api/counterexample", {
    oldSchema: oldS,
    newSchema: newS,
    perspective: "request",
    kind: "type",
    pointer: "/properties/phone",
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.constructible, false);
  assert.ok(typeof res.data.reason === "string" && res.data.reason.length > 0);
  assert.equal(res.data.sample, undefined);
});

test("POST /api/counterexample validates its input", async () => {
  const missingSchema = await post("/api/counterexample", { oldSchema: {} });
  assert.equal(missingSchema.status, 400);
  assert.match(missingSchema.data.error, /newSchema/);

  const badPerspective = await post("/api/counterexample", {
    oldSchema: {},
    newSchema: {},
    perspective: "nope",
    kind: "type",
    pointer: "",
  });
  assert.equal(badPerspective.status, 400);
  assert.match(badPerspective.data.error, /perspective/);

  const missingKind = await post("/api/counterexample", {
    oldSchema: {},
    newSchema: {},
    pointer: "",
  });
  assert.equal(missingKind.status, 400);
  assert.match(missingKind.data.error, /kind/);

  const badPointer = await post("/api/counterexample", {
    oldSchema: {},
    newSchema: {},
    kind: "type",
    pointer: "bad",
  });
  assert.equal(badPointer.status, 400);
  assert.match(badPointer.data.error, /JSON Pointer/);

  const badKind = await post("/api/counterexample", {
    oldSchema: {},
    newSchema: {},
    kind: "nope",
    pointer: "",
  });
  assert.equal(badKind.status, 400);
  assert.match(badKind.data.error, /暂不支持/);
});

test("POST /api/counterexample rejects an invalid schema with 422", async () => {
  const res = await post("/api/counterexample", {
    oldSchema: { type: "not-a-type" },
    newSchema: {},
    kind: "type",
    pointer: "",
  });
  assert.equal(res.status, 422);
  assert.match(res.data.error, /Invalid schema/);
});

test("POST /api/scan classifies historical samples against both versions", async () => {
  const oldS = (
    await post("/api/infer", { samples: [{ id: 1, phone: null }, { id: 2, phone: "x" }] })
  ).data.schema;
  const newS = (await post("/api/infer", { samples: [{ id: 1, phone: "x" }] })).data.schema;

  const res = await post("/api/scan", {
    oldSchema: oldS,
    newSchema: newS,
    samples: [
      { id: 1, phone: "a" }, // passes both
      { id: 2, phone: null }, // baseline only: null no longer accepted
      { id: 3 }, // neither: phone is required in both versions
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 3);
  assert.deepEqual(res.data.summary, { both: 1, baselineOnly: 1, currentOnly: 0, neither: 1 });
  assert.deepEqual(
    res.data.samples.map((s) => s.category),
    ["both", "baselineOnly", "neither"]
  );
  const broken = res.data.samples[1];
  assert.equal(broken.index, 1);
  assert.equal(broken.baseline.valid, true);
  assert.deepEqual(broken.baseline.errors, []);
  assert.equal(broken.current.valid, false);
  assert.equal(broken.current.errors[0].pointer, "/phone");
  assert.equal(broken.current.errors[0].keyword, "type");
  assert.ok(broken.current.errors[0].message);
});

test("POST /api/scan detects samples only the current schema accepts", async () => {
  const oldS = (await post("/api/infer", { samples: [{ id: 1 }] })).data.schema;
  const newS = (await post("/api/infer", { samples: [{ id: 1 }, { id: 1.5 }] })).data.schema;
  const res = await post("/api/scan", {
    oldSchema: oldS,
    newSchema: newS,
    samples: [{ id: 1.5 }],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.summary, { both: 0, baselineOnly: 0, currentOnly: 1, neither: 0 });
  assert.equal(res.data.samples[0].category, "currentOnly");
  assert.equal(res.data.samples[0].baseline.valid, false);
  assert.equal(res.data.samples[0].current.valid, true);
});

test("POST /api/scan accepts an empty sample set", async () => {
  const res = await post("/api/scan", { oldSchema: {}, newSchema: {}, samples: [] });
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 0);
  assert.deepEqual(res.data.summary, { both: 0, baselineOnly: 0, currentOnly: 0, neither: 0 });
  assert.deepEqual(res.data.samples, []);
});

test("POST /api/scan rejects non-array input and more than 200 samples", async () => {
  const notArray = await post("/api/scan", { oldSchema: {}, newSchema: {}, samples: { 0: 1 } });
  assert.equal(notArray.status, 400);
  assert.match(notArray.data.error, /'samples' array/);

  const missing = await post("/api/scan", { oldSchema: {}, newSchema: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /'samples' array/);

  const tooMany = await post("/api/scan", {
    oldSchema: {},
    newSchema: {},
    samples: Array.from({ length: 201 }, () => 1),
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /200/);

  const atLimit = await post("/api/scan", {
    oldSchema: {},
    newSchema: {},
    samples: Array.from({ length: 200 }, () => 1),
  });
  assert.equal(atLimit.status, 200);
  assert.equal(atLimit.data.total, 200);
});

test("POST /api/scan validates its schemas", async () => {
  const missingSchema = await post("/api/scan", { samples: [] });
  assert.equal(missingSchema.status, 400);
  assert.match(missingSchema.data.error, /oldSchema/);

  const invalid = await post("/api/scan", {
    oldSchema: { type: "not-a-type" },
    newSchema: {},
    samples: [1],
  });
  assert.equal(invalid.status, 422);
  assert.match(invalid.data.error, /Invalid schema/);
});

test("POST /api/contribution classifies samples via leave-one-out inference", async () => {
  const res = await post("/api/contribution", {
    samples: [{ id: 1, tag: "x" }, { id: 2, tag: "y" }, { id: 3 }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 3);
  assert.deepEqual(res.data.summary, { critical: 1, redundant: 2 });
  assert.deepEqual(
    res.data.samples.map((s) => [s.index, s.verdict]),
    [
      [0, "redundant"],
      [1, "redundant"],
      [2, "critical"],
    ]
  );
  // Without sample #2, "tag" is present in every remaining object -> required.
  assert.deepEqual(res.data.samples[2].affectedPointers, ["/properties/tag"]);
  assert.deepEqual(res.data.samples[0].affectedPointers, []);
});

test("POST /api/contribution validates its input", async () => {
  const missing = await post("/api/contribution", {});
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /'samples' array/);

  const notArray = await post("/api/contribution", { samples: { 0: 1 } });
  assert.equal(notArray.status, 400);
  assert.match(notArray.data.error, /'samples' array/);

  const empty = await post("/api/contribution", { samples: [] });
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /'samples' array/);

  const tooMany = await post("/api/contribution", {
    samples: Array.from({ length: 51 }, () => 1),
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /50/);

  const atLimit = await post("/api/contribution", {
    samples: Array.from({ length: 50 }, (_, i) => ({ id: i })),
  });
  assert.equal(atLimit.status, 200);
  assert.equal(atLimit.data.total, 50);
});

test("POST /api/anonymize replaces matched scalars with stable typed pseudonyms", async () => {
  const { status, data } = await post("/api/anonymize", {
    samples: [
      { id: 1, email: "a@x.com", tags: ["x", "y"] },
      { id: 2, email: "a@x.com", tags: ["x"] },
    ],
    rules: ["/email", "/tags/*"],
  });
  assert.equal(status, 200);
  assert.equal(data.totalSamples, 2);
  const [emailRule, tagsRule] = data.rules;
  assert.equal(emailRule.status, "ok");
  assert.equal(emailRule.hits, 2);
  assert.deepEqual(emailRule.paths, ["#/0/email", "#/1/email"]);
  assert.equal(tagsRule.hits, 3);
  // Stable across samples, actually replaced, type preserved.
  assert.equal(data.samples[0].email, data.samples[1].email);
  assert.notEqual(data.samples[0].email, "a@x.com");
  assert.equal(typeof data.samples[0].email, "string");
  assert.notEqual(data.samples[0].tags[0], "x");
  assert.equal(data.samples[0].id, 1); // untouched
});

test("POST /api/anonymize refuses illegal pointers, non-scalar hits and conflicts with 422 + rule stats", async () => {
  const illegal = await post("/api/anonymize", { samples: [{ a: 1 }], rules: ["a"] });
  assert.equal(illegal.status, 422);
  assert.equal(illegal.data.rules[0].status, "invalid");
  assert.match(illegal.data.error, /规则 1/);
  assert.equal(illegal.data.samples, undefined);

  const nonScalar = await post("/api/anonymize", {
    samples: [{ a: { b: 1 } }],
    rules: ["/a"],
  });
  assert.equal(nonScalar.status, 422);
  assert.equal(nonScalar.data.rules[0].status, "non-scalar");
  assert.match(nonScalar.data.rules[0].error, /对象/);

  const conflict = await post("/api/anonymize", {
    samples: [{ a: { b: 1 } }],
    rules: ["/a/*", "/a/b"],
  });
  assert.equal(conflict.status, 422);
  assert.equal(conflict.data.rules[0].status, "conflict");
  assert.equal(conflict.data.rules[1].status, "conflict");
  assert.equal(conflict.data.samples, undefined);
});

test("POST /api/anonymize validates its input", async () => {
  const noSamples = await post("/api/anonymize", { rules: ["/a"] });
  assert.equal(noSamples.status, 400);
  assert.match(noSamples.data.error, /'samples' array/);

  const noRules = await post("/api/anonymize", { samples: [{ a: 1 }], rules: [] });
  assert.equal(noRules.status, 400);
  assert.match(noRules.data.error, /'rules' array/);

  const badRule = await post("/api/anonymize", { samples: [{ a: 1 }], rules: [42] });
  assert.equal(badRule.status, 400);
  assert.match(badRule.data.error, /JSON Pointer string/);

  const tooMany = await post("/api/anonymize", {
    samples: Array.from({ length: 201 }, () => ({})),
    rules: ["/a"],
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /200/);
});

test("POST /api/slice keeps only the picked nodes and projects the samples", async () => {
  const samples = [
    { id: 1, name: "a", address: { city: "x", zip: "1" } },
    { id: 2, name: "b", address: { city: "y", zip: "2" } },
  ];
  const { data: inferred } = await post("/api/infer", { samples });

  const res = await post("/api/slice", {
    schema: inferred.schema,
    samples,
    pointers: ["/properties/address/properties/city"],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.sampleCount, 2);
  assert.equal(res.data.fieldCount, 2); // address + city
  assert.equal(res.data.schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(Object.keys(res.data.schema.properties), ["address"]);
  assert.deepEqual(res.data.schema.required, ["address"]);
  assert.deepEqual(Object.keys(res.data.schema.properties.address.properties), ["city"]);
  assert.deepEqual(res.data.schema.properties.address.required, ["city"]);
  assert.deepEqual(res.data.samples, [{ address: { city: "x" } }, { address: { city: "y" } }]);
  assert.deepEqual(res.data.pointers, ["/properties/address/properties/city"]);
  assert.deepEqual(res.data.ignored, []);
});

test("POST /api/slice ignores pointers covered by a selected ancestor", async () => {
  const samples = [{ a: { b: 1, c: 2 } }];
  const { data: inferred } = await post("/api/infer", { samples });
  const res = await post("/api/slice", {
    schema: inferred.schema,
    samples,
    pointers: ["/properties/a/properties/b", "/properties/a"],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.pointers, ["/properties/a"]);
  assert.equal(res.data.ignored.length, 1);
  assert.equal(res.data.ignored[0].pointer, "/properties/a/properties/b");
  assert.match(res.data.ignored[0].reason, /已被祖先/);
  // The ancestor keeps the whole subtree and the whole sample value.
  assert.deepEqual(Object.keys(res.data.schema.properties.a.properties), ["b", "c"]);
  assert.deepEqual(res.data.samples, samples);
});

test("POST /api/slice refuses with 422 + sample indexes when a projection fails validation", async () => {
  const res = await post("/api/slice", {
    schema: {
      type: "object",
      properties: { a: { type: "integer", const: 1 } },
      required: ["a"],
    },
    samples: [{ a: 1 }, { a: 2 }],
    pointers: ["/properties/a"],
  });
  assert.equal(res.status, 422);
  assert.match(res.data.error, /未产出切片/);
  // No slice is produced on failure.
  assert.equal(res.data.schema, undefined);
  assert.equal(res.data.samples, undefined);
  assert.equal(res.data.failures.length, 1);
  assert.equal(res.data.failures[0].index, 1);
  assert.equal(res.data.failures[0].errors[0].keyword, "const");
  assert.equal(res.data.failures[0].errors[0].pointer, "/a");
});

test("POST /api/slice validates its input", async () => {
  const noSchema = await post("/api/slice", { samples: [{}], pointers: [""] });
  assert.equal(noSchema.status, 400);
  assert.match(noSchema.data.error, /'schema' object/);

  const noSamples = await post("/api/slice", { schema: {}, pointers: [""] });
  assert.equal(noSamples.status, 400);
  assert.match(noSamples.data.error, /'samples' array/);

  const noPointers = await post("/api/slice", { schema: {}, samples: [{}], pointers: [] });
  assert.equal(noPointers.status, 400);
  assert.match(noPointers.data.error, /'pointers' array/);

  const tooManyPointers = await post("/api/slice", {
    schema: {},
    samples: [{}],
    pointers: Array.from({ length: 21 }, (_, i) => `/p${i}`),
  });
  assert.equal(tooManyPointers.status, 400);
  assert.match(tooManyPointers.data.error, /20/);

  const tooManySamples = await post("/api/slice", {
    schema: {},
    samples: Array.from({ length: 201 }, () => 1),
    pointers: [""],
  });
  assert.equal(tooManySamples.status, 400);
  assert.match(tooManySamples.data.error, /200/);

  const illegal = await post("/api/slice", { schema: {}, samples: [{}], pointers: ["oops"] });
  assert.equal(illegal.status, 422);
  assert.equal(illegal.data.invalidPointers.length, 1);
  assert.match(illegal.data.invalidPointers[0].reason, /Pointer 非法/);

  const unresolvable = await post("/api/slice", {
    schema: { type: "object", properties: { a: { type: "string" } } },
    samples: [{ a: "x" }],
    pointers: ["/properties/nope"],
  });
  assert.equal(unresolvable.status, 422);
  assert.match(unresolvable.data.invalidPointers[0].reason, /未命中/);
});

test("POST /api/migrate moves historical samples and groups success/conflict/invalid", async () => {
  const oldS = (
    await post("/api/infer", { samples: [{ id: 1, phone: "a" }, { id: 2, phone: null }] })
  ).data.schema;
  const newS = (
    await post("/api/infer", {
      samples: [{ id: 1, contact: { phone: "a" } }, { id: 2, contact: { phone: "b" } }],
    })
  ).data.schema;

  const res = await post("/api/migrate", {
    baselineSchema: oldS,
    currentSchema: newS,
    samples: [
      { id: 1, phone: "123" }, // success
      { id: 2, contact: { phone: "x" } }, // success: missing source, nothing to move
      { id: 3, phone: "1", contact: { phone: "2" } }, // conflict: target pre-exists
      { id: 4, phone: 9 }, // invalid: number not accepted at contact/phone
    ],
    mappings: [{ from: "/phone", to: "/contact/phone" }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 4);
  assert.deepEqual(res.data.summary, { success: 2, conflict: 1, invalid: 1 });
  // The plan orders operations by depth before touching any sample.
  assert.ok(Array.isArray(res.data.plan.sourceRemovals));
  assert.ok(Array.isArray(res.data.plan.targetWrites));
  assert.deepEqual(res.data.mappings, [
    { index: 0, from: "/phone", to: "/contact/phone", hasDefault: false },
  ]);

  const [success, skipped, conflict, invalid] = res.data.samples;
  assert.deepEqual(success.after, { id: 1, contact: { phone: "123" } });
  assert.equal(success.current.valid, true);
  assert.equal(success.baseline.valid, true);
  assert.equal(skipped.operations[0].kind, "skip");

  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.after, null);
  assert.deepEqual(conflict.before, { id: 3, phone: "1", contact: { phone: "2" } });
  assert.match(conflict.reasons[0], /contact\/phone/);

  assert.equal(invalid.status, "invalid");
  assert.deepEqual(invalid.after, { id: 4, contact: { phone: 9 } });
  assert.equal(invalid.current.valid, false);
  assert.equal(invalid.current.errors[0].pointer, "/contact/phone");
  assert.equal(invalid.current.errors[0].keyword, "type");
});

test("POST /api/migrate supports defaults, arrays (-) and depth-planned parent/child sources", async () => {
  const res = await post("/api/migrate", {
    currentSchema: {},
    samples: [{ id: 1, phone: "x", meta: { tags: ["a"], v: 2 } }],
    mappings: [
      { from: "/phone", to: "/contact/phone" },
      { from: "/meta/tags/0", to: "/extra/tags/-" },
      { from: "/version", to: "/v", default: 1 },
    ],
  });
  assert.equal(res.status, 200);
  const item = res.data.samples[0];
  assert.equal(item.status, "success");
  assert.deepEqual(item.after, {
    id: 1,
    meta: { tags: [], v: 2 },
    contact: { phone: "x" },
    extra: { tags: ["a"] },
    v: 1,
  });
  // Deepest source removal is planned before its ancestors.
  assert.equal(res.data.plan.sourceRemovals[0].pointer, "/meta/tags/0");
});

test("POST /api/migrate swaps array elements by pre-migration indexes (no element lost)", async () => {
  const res = await post("/api/migrate", {
    currentSchema: {},
    samples: [{ arr: ["A", "B", "C"] }],
    mappings: [
      { from: "/arr/0", to: "/arr/1" },
      { from: "/arr/1", to: "/arr/0" },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.summary.success, 1);
  // The untouched "C" survives; the two swapped slots trade values.
  assert.deepEqual(res.data.samples[0].after, { arr: ["B", "A", "C"] });

  // Mapping input order must not change the result.
  const reversed = await post("/api/migrate", {
    currentSchema: {},
    samples: [{ arr: ["A", "B", "C"] }],
    mappings: [
      { from: "/arr/1", to: "/arr/0" },
      { from: "/arr/0", to: "/arr/1" },
    ],
  });
  assert.equal(reversed.status, 200);
  assert.deepEqual(reversed.data.samples[0].after, { arr: ["B", "A", "C"] });
});

test("POST /api/migrate rejects invalid mappings with 422 and details", async () => {
  const badPointer = await post("/api/migrate", {
    currentSchema: {},
    samples: [{ a: 1 }],
    mappings: [{ from: "a", to: "/b" }],
  });
  assert.equal(badPointer.status, 422);
  assert.equal(badPointer.data.invalidMappings[0].index, 0);

  const overlap = await post("/api/migrate", {
    currentSchema: {},
    samples: [{ a: 1, b: 2 }],
    mappings: [
      { from: "/a", to: "/x" },
      { from: "/b", to: "/x/y" },
    ],
  });
  assert.equal(overlap.status, 422);
  assert.equal(overlap.data.invalidMappings[0].index, 1);
  assert.match(overlap.data.error, /父子重叠/);
  // No per-sample output when the mapping set itself is invalid.
  assert.equal(overlap.data.samples, undefined);
});

test("POST /api/migrate validates its input", async () => {
  const noSchema = await post("/api/migrate", {
    samples: [1],
    mappings: [{ from: "/a", to: "/b" }],
  });
  assert.equal(noSchema.status, 400);
  assert.match(noSchema.data.error, /currentSchema/);

  const noSamples = await post("/api/migrate", {
    currentSchema: {},
    mappings: [{ from: "/a", to: "/b" }],
  });
  assert.equal(noSamples.status, 400);
  assert.match(noSamples.data.error, /'samples' array/);

  const noMappings = await post("/api/migrate", { currentSchema: {}, samples: [1] });
  assert.equal(noMappings.status, 400);
  assert.match(noMappings.data.error, /'mappings' array/);

  const tooMany = await post("/api/migrate", {
    currentSchema: {},
    samples: Array.from({ length: 201 }, () => 1),
    mappings: [{ from: "/a", to: "/b" }],
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /200/);

  const invalidSchema = await post("/api/migrate", {
    currentSchema: { type: "nope" },
    samples: [1],
    mappings: [{ from: "/a", to: "/b" }],
  });
  assert.equal(invalidSchema.status, 422);
  assert.match(invalidSchema.data.error, /Invalid schema/);
});

test("POST /api/relation/mine reports implication and exclusion candidates per scope", async () => {
  const samples = [
    { id: 1, phone: "a", home: "h" },
    { id: 2, phone: "b", home: "i" },
    { id: 3, work: "w" },
    { id: 4, work: "x" },
  ];
  const { data: inferred } = await post("/api/infer", { samples });
  const res = await post("/api/relation/mine", { samples, schema: inferred.schema });
  assert.equal(res.status, 200);
  assert.equal(res.data.sampleCount, 4);
  assert.equal(res.data.scopeCount, 4);
  assert.equal(res.data.minSupport, 2);
  assert.ok(res.data.summary.removedByTransitiveReduction >= 0);

  const root = res.data.scopes.find((g) => g.scopePointer === "");
  const pairs = root.implications.map((r) => `${r.a}->${r.b}`);
  assert.ok(pairs.includes("phone->home"));
  assert.ok(pairs.includes("home->phone"));
  // phone/home imply the required id; work implies id too but that edge is
  // already enforced, and work has no implication toward phone/home.
  assert.equal(pairs.some((p) => p.startsWith("work->phone") || p.startsWith("work->home")), false);
  assert.equal(pairs.includes("phone->work"), false);

  const exclusions = root.exclusions.map((r) => `${r.a}/${r.b}`).sort();
  assert.deepEqual(exclusions, ["home/work", "phone/work"]);
  const phoneWork = root.exclusions.find((r) => r.a === "phone" && r.b === "work");
  assert.equal(phoneWork.support, 2);
  assert.deepEqual(phoneWork.witnessPathsA, ["#/0", "#/1"]);
  assert.deepEqual(phoneWork.witnessPathsB, ["#/2", "#/3"]);
});

test("POST /api/relation/mine handles array element scopes independently", async () => {
  const samples = [
    { list: [{ a: 1, b: 2 }, { a: 3, b: 4 }] },
    { list: [{ a: 5 }] },
  ];
  const res = await post("/api/relation/mine", { samples });
  assert.equal(res.status, 200);
  const items = res.data.scopes.find(
    (g) => g.scopePointer === "/properties/list/items"
  );
  assert.equal(items.scopeCount, 3);
  assert.deepEqual(items.implications.map((r) => `${r.a}->${r.b}`), ["b->a"]);
  assert.deepEqual(items.implications[0].witnessPaths, ["#/0/list/0", "#/0/list/1"]);
});

test("POST /api/relation/mine validates its input", async () => {
  const empty = await post("/api/relation/mine", { samples: [] });
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /'samples' array/);

  const tooMany = await post("/api/relation/mine", {
    samples: Array.from({ length: 201 }, () => ({})),
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /200/);

  const badSchema = await post("/api/relation/mine", { samples: [{}], schema: [] });
  assert.equal(badSchema.status, 400);
  assert.match(badSchema.data.error, /'schema' object/);
});

test("POST /api/relation/enhance builds dependentRequired + not/required and revalidates all samples", async () => {
  const samples = [
    { id: 1, a: 1, b: 2 },
    { id: 2, a: 3, b: 4 },
    { id: 3, c: true },
    { id: 4, c: false },
  ];
  const { data: inferred } = await post("/api/infer", { samples });
  const mined = await post("/api/relation/mine", { samples, schema: inferred.schema });
  const root = mined.data.scopes[0];
  const ruleIds = [
    ...root.implications.filter((r) => !r.alreadyEnforced).map((r) => r.id),
    ...root.exclusions.map((r) => r.id),
  ];

  const res = await post("/api/relation/enhance", {
    schema: inferred.schema,
    samples,
    ruleIds,
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.ruleCount, ruleIds.length);
  assert.equal(res.data.sampleCount, 4);
  assert.deepEqual(res.data.schema.dependentRequired, { a: ["b"], b: ["a"] });
  assert.deepEqual(res.data.schema.allOf, [
    { not: { required: ["a", "c"] } },
    { not: { required: ["b", "c"] } },
  ]);

  // The produced schema actually enforces the rules (checked server-side
  // via /api/validate).
  const violating = await post("/api/validate", {
    schema: res.data.schema,
    sample: { id: 9, a: 1, c: true },
  });
  assert.equal(violating.data.valid, false);
  assert.ok(violating.data.errors.some((e) => e.keyword === "not"));
});

test("POST /api/relation/enhance refuses 422 and produces no schema when a sample fails Ajv", async () => {
  const samples = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  const res = await post("/api/relation/enhance", {
    schema: {
      type: "object",
      properties: { a: { type: "integer", minimum: 100 }, b: { type: "integer" } },
    },
    samples,
    ruleIds: [makeRuleId("implication", "", "a", "b"), makeRuleId("implication", "", "b", "a")],
  });
  assert.equal(res.status, 422);
  assert.equal(res.data.schema, undefined);
  assert.match(res.data.error, /复验/);
  assert.equal(res.data.failures.length, 2);
  assert.equal(res.data.failures[0].errors[0].keyword, "minimum");
});

test("POST /api/relation/enhance rejects unknown rule ids with 422 details", async () => {
  const res = await post("/api/relation/enhance", {
    schema: { type: "object" },
    samples: [{}],
    ruleIds: [makeRuleId("implication", "", "nope", "zzz")],
  });
  assert.equal(res.status, 422);
  assert.equal(res.data.schema, undefined);
  assert.equal(res.data.invalidRules.length, 1);
  assert.equal(res.data.invalidRules[0].index, 0);
  assert.match(res.data.invalidRules[0].reason, /失效/);
});

test("POST /api/relation/enhance validates its input shape", async () => {
  const noSchema = await post("/api/relation/enhance", {
    samples: [{}],
    ruleIds: [],
  });
  assert.equal(noSchema.status, 400);
  assert.match(noSchema.data.error, /'schema' object/);

  const noSamples = await post("/api/relation/enhance", {
    schema: {},
    ruleIds: [],
  });
  assert.equal(noSamples.status, 400);
  assert.match(noSamples.data.error, /'samples' array/);

  const noRules = await post("/api/relation/enhance", { schema: {}, samples: [{}] });
  assert.equal(noRules.status, 400);
  assert.match(noRules.data.error, /'ruleIds' array/);

  const badId = await post("/api/relation/enhance", {
    schema: {},
    samples: [{}],
    ruleIds: [42],
  });
  assert.equal(badId.status, 400);
  assert.match(badId.data.error, /rule id/);
});

test("malformed JSON body gets a JSON 400", async () => {  const res = await fetch(`${base}/api/infer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error);
});

test("unknown API route returns JSON 404", async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.ok(data.error);
});
