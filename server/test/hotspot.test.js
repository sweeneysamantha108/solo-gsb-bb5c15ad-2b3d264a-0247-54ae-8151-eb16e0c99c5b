"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeHotspots, MAX_SAMPLES } = require("../hotspot");

test("analyzeHotspots merges the same rule across array indexes into one cluster", () => {
  const schema = {
    type: "object",
    properties: { tags: { type: "array", items: { type: "string" } } },
    required: ["tags"],
  };
  const { total, validCount, invalidCount, errorCount, clusterCount, clusters } =
    analyzeHotspots({
      schema,
      samples: [
        { tags: [1, 2] }, // two item errors
        { tags: ["ok"] }, // valid
        { tags: [3] }, // one item error
      ],
    });
  assert.equal(total, 3);
  assert.equal(validCount, 1);
  assert.equal(invalidCount, 2);
  assert.equal(errorCount, 3);
  assert.equal(clusterCount, 1);
  const [cluster] = clusters;
  assert.equal(cluster.keyword, "type");
  assert.equal(cluster.schemaPath, "#/properties/tags/items/type");
  assert.equal(cluster.sampleCount, 2);
  assert.equal(cluster.errorCount, 3);
  assert.deepEqual(cluster.sampleIndexes, [0, 2]);
  assert.deepEqual(
    cluster.occurrences.map((o) => [o.index, o.pointer]),
    [
      [0, "/tags/0"],
      [0, "/tags/1"],
      [2, "/tags/0"],
    ]
  );
  assert.equal(cluster.missingProperty, undefined);
  assert.equal(cluster.additionalProperty, undefined);
});

test("analyzeHotspots splits required errors by missingProperty", () => {
  const schema = { type: "object", required: ["a", "b"] };
  const { clusters, errorCount } = analyzeHotspots({ schema, samples: [{}, { c: 1 }] });
  assert.equal(errorCount, 4);
  assert.equal(clusters.length, 2);
  const byProp = new Map(clusters.map((c) => [c.missingProperty, c]));
  assert.deepEqual([...byProp.keys()].sort(), ["a", "b"]);
  for (const cluster of byProp.values()) {
    assert.equal(cluster.keyword, "required");
    assert.equal(cluster.schemaPath, "#/required");
    assert.equal(cluster.sampleCount, 2);
    assert.equal(cluster.errorCount, 2);
    assert.deepEqual(cluster.sampleIndexes, [0, 1]);
    // A required violation points at the object missing the property.
    assert.equal(cluster.occurrences[0].pointer, "(root)");
    assert.equal(cluster.occurrences[0].path, "");
    assert.deepEqual(cluster.occurrences[0].params, {
      missingProperty: cluster.missingProperty,
    });
  }
});

test("analyzeHotspots splits additionalProperties errors by additionalProperty", () => {
  const schema = {
    type: "object",
    properties: { id: { type: "integer" } },
    additionalProperties: false,
  };
  const { clusters } = analyzeHotspots({ schema, samples: [{ id: 1, x: 1, y: 2 }] });
  assert.equal(clusters.length, 2);
  const byProp = new Map(clusters.map((c) => [c.additionalProperty, c]));
  assert.deepEqual([...byProp.keys()].sort(), ["x", "y"]);
  for (const cluster of byProp.values()) {
    assert.equal(cluster.keyword, "additionalProperties");
    assert.equal(cluster.schemaPath, "#/additionalProperties");
    assert.equal(cluster.sampleCount, 1);
    assert.equal(cluster.errorCount, 1);
  }
});

test("analyzeHotspots keeps the same keyword at different schema paths apart", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
  };
  const { clusters } = analyzeHotspots({ schema, samples: [{ a: 1, b: 2 }] });
  assert.equal(clusters.length, 2);
  assert.deepEqual(
    clusters.map((c) => c.schemaPath).sort(),
    ["#/properties/a/type", "#/properties/b/type"]
  );
  assert.ok(clusters.every((c) => c.keyword === "type" && c.errorCount === 1));
});

test("analyzeHotspots sorts clusters by affected-sample count, then error count", () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "string" },
      list: { type: "array", items: { type: "integer" } },
    },
    required: ["a"],
  };
  const { clusters } = analyzeHotspots({
    schema,
    samples: [
      { list: ["x", "y"] }, // missing a + 2 item errors
      { a: 1, list: ["z"] }, // wrong a type + 1 item error
      { list: [] }, // missing a only
    ],
  });
  // items/type and required#a both touch 2 samples; the 3-error items
  // cluster wins the tie-break, properties/a/type trails with 1 sample.
  assert.deepEqual(
    clusters.map((c) => [c.keyword, c.sampleCount, c.errorCount]),
    [
      ["type", 2, 3],
      ["required", 2, 2],
      ["type", 1, 1],
    ]
  );
  assert.equal(clusters[0].schemaPath, "#/properties/list/items/type");
  assert.equal(clusters[1].missingProperty, "a");
  assert.equal(clusters[2].schemaPath, "#/properties/a/type");
});

test("analyzeHotspots reports an all-valid run with no clusters", () => {
  const { total, validCount, invalidCount, errorCount, clusterCount, clusters } =
    analyzeHotspots({ schema: { type: "integer" }, samples: [1, 2, 3] });
  assert.equal(total, 3);
  assert.equal(validCount, 3);
  assert.equal(invalidCount, 0);
  assert.equal(errorCount, 0);
  assert.equal(clusterCount, 0);
  assert.deepEqual(clusters, []);
});

test("analyzeHotspots accepts an empty sample set", () => {
  const result = analyzeHotspots({ schema: {}, samples: [] });
  assert.equal(result.total, 0);
  assert.equal(result.validCount, 0);
  assert.equal(result.clusterCount, 0);
  assert.deepEqual(result.clusters, []);
});

test("analyzeHotspots rejects a non-array sample set with status 400", () => {
  for (const samples of [undefined, null, "nope", { 0: 1 }, 42]) {
    assert.throws(
      () => analyzeHotspots({ schema: {}, samples }),
      (err) => err.status === 400 && /'samples' array/.test(err.message)
    );
  }
});

test(`analyzeHotspots rejects more than ${MAX_SAMPLES} samples with status 400`, () => {
  const samples = Array.from({ length: MAX_SAMPLES + 1 }, () => 1);
  assert.throws(
    () => analyzeHotspots({ schema: {}, samples }),
    (err) => err.status === 400 && new RegExp(`${MAX_SAMPLES}`).test(err.message)
  );
  // Exactly at the limit is fine.
  const ok = analyzeHotspots({
    schema: { type: "integer" },
    samples: Array.from({ length: MAX_SAMPLES }, () => 1),
  });
  assert.equal(ok.total, MAX_SAMPLES);
  assert.equal(ok.validCount, MAX_SAMPLES);
});

test("analyzeHotspots rejects an uncompilable schema with status 422", () => {
  assert.throws(
    () => analyzeHotspots({ schema: { type: "not-a-type" }, samples: [1] }),
    (err) => err.status === 422 && /Invalid schema/.test(err.message)
  );
});
