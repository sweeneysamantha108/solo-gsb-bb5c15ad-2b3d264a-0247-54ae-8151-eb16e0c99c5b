"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { anonymizeSamples, MAX_SAMPLES, MAX_PATHS_PER_RULE } = require("../anonymize");

test("anonymizeSamples replaces matched scalars with stable, type-preserving pseudonyms", () => {
  const samples = [
    { id: 1, email: "a@x.com", age: 30, score: 1.5, vip: true, note: null },
    { id: 2, email: "a@x.com", age: 41, score: 2.5, vip: false, note: null },
    { id: 3, email: "b@x.com", age: 30, score: 1.5, vip: true, note: null },
  ];
  const { samples: out, rules, totalSamples } = anonymizeSamples({
    samples,
    rules: ["/email", "/age", "/score", "/vip", "/note"],
  });

  assert.equal(totalSamples, 3);
  assert.ok(rules.every((r) => r.status === "ok" && r.error === null));

  // Strings: stable across samples, different originals never merge.
  assert.equal(out[0].email, out[1].email);
  assert.notEqual(out[0].email, out[2].email);
  assert.equal(typeof out[0].email, "string");
  assert.notEqual(out[0].email, "a@x.com");

  // Integers stay integers; equal originals map consistently.
  assert.ok(Number.isInteger(out[0].age));
  assert.notEqual(out[0].age, 30);
  assert.equal(out[0].age, out[2].age);
  assert.notEqual(out[0].age, out[1].age);

  // Floats stay non-integer.
  assert.ok(!Number.isInteger(out[0].score));
  assert.equal(out[0].score, out[2].score);
  assert.notEqual(out[0].score, out[1].score);

  // Booleans stay booleans (negated: the only injective map that hides the value).
  assert.equal(out[0].vip, false);
  assert.equal(out[1].vip, true);
  assert.equal(out[2].vip, false);

  // null stays null; untouched fields are left alone; originals are not mutated.
  assert.equal(out[0].note, null);
  assert.equal(out[0].id, 1);
  assert.equal(samples[0].email, "a@x.com");
  assert.equal(samples[0].age, 30);
});

test("anonymizeSamples reports per-rule hit counts, paths and misses", () => {
  const { rules } = anonymizeSamples({
    samples: [{ a: 1 }, { a: 2 }, { b: 3 }],
    rules: ["/a", "/missing"],
  });
  assert.equal(rules[0].hits, 2);
  assert.deepEqual(rules[0].paths, ["#/0/a", "#/1/a"]);
  assert.equal(rules[0].pathsTruncated, false);
  assert.equal(rules[1].hits, 0);
  assert.deepEqual(rules[1].paths, []);
});

test("anonymizeSamples supports RFC 6901 escaping in patterns", () => {
  const { samples: out, rules } = anonymizeSamples({
    samples: [{ "a~b": "x", "a/b": "y", "a*": "z" }],
    rules: ["/a~0b", "/a~1b"],
  });
  assert.deepEqual(rules.map((r) => r.hits), [1, 1]);
  assert.notEqual(out[0]["a~b"], "x");
  assert.notEqual(out[0]["a/b"], "y");
  assert.equal(out[0]["a*"], "z"); // not addressed by the two rules
});

test("anonymizeSamples wildcard matches object keys and array indexes", () => {
  const { samples: out, rules } = anonymizeSamples({
    samples: [
      { tags: ["a", "b"], meta: { x: 1, y: 2 }, keep: "k" },
      { tags: [], meta: {} },
    ],
    rules: ["/tags/*", "/meta/*"],
  });
  assert.deepEqual(rules.map((r) => r.hits), [2, 2]);
  assert.deepEqual(rules[0].paths, ["#/0/tags/0", "#/0/tags/1"]);
  assert.deepEqual(rules[1].paths, ["#/0/meta/x", "#/0/meta/y"]);
  assert.notEqual(out[0].tags[0], "a");
  assert.notEqual(out[0].tags[1], "b");
  assert.ok(Number.isInteger(out[0].meta.x));
  assert.notEqual(out[0].meta.x, 1);
  assert.equal(out[0].keep, "k");
});

test("anonymizeSamples supports a root-level wildcard and literal array indexes", () => {
  const root = anonymizeSamples({ samples: [{ a: "x", b: "y" }], rules: ["/*"] });
  assert.equal(root.rules[0].hits, 2);
  assert.notEqual(root.samples[0].a, "x");
  assert.notEqual(root.samples[0].b, "y");

  const indexed = anonymizeSamples({
    samples: [{ tags: ["a", "b", "c"] }],
    rules: ["/tags/0", "/tags/5", "/tags/01"],
  });
  assert.deepEqual(indexed.rules.map((r) => r.hits), [1, 0, 0]);
  assert.notEqual(indexed.samples[0].tags[0], "a");
  assert.equal(indexed.samples[0].tags[1], "b");
  assert.equal(indexed.samples[0].tags[2], "c");
});

test("anonymizeSamples matches the sample root with an empty pattern", () => {
  const ok = anonymizeSamples({ samples: ["secret", 7], rules: [""] });
  assert.equal(ok.rules[0].hits, 2);
  assert.notEqual(ok.samples[0], "secret");
  assert.ok(Number.isInteger(ok.samples[1]));
  assert.notEqual(ok.samples[1], 7);

  // The root of an object sample is not a scalar: refused.
  assert.throws(
    () => anonymizeSamples({ samples: [{ a: 1 }], rules: [""] }),
    (err) => err.status === 422 && err.details.rules[0].status === "non-scalar"
  );
});

test("anonymizeSamples is deterministic across runs", () => {
  const input = {
    samples: [
      { email: "a@x.com", age: 30, tags: ["x", "y"] },
      { email: "b@x.com", age: 41, tags: [] },
    ],
    rules: ["/email", "/age", "/tags/*"],
  };
  const first = anonymizeSamples(input);
  const second = anonymizeSamples(input);
  assert.deepEqual(second, first);
});

test("anonymizeSamples never merges different originals, even for integers", () => {
  const samples = Array.from({ length: 60 }, (_, i) => ({ age: i, name: `user-${i}` }));
  const { samples: out } = anonymizeSamples({ samples, rules: ["/age", "/name"] });
  assert.equal(new Set(out.map((s) => s.age)).size, 60);
  assert.equal(new Set(out.map((s) => s.name)).size, 60);
  assert.ok(out.every((s) => Number.isInteger(s.age)));
  assert.ok(out.every((s) => typeof s.name === "string" && !s.name.startsWith("user-")));
});

test("anonymizeSamples keeps rules independent from each other", () => {
  const { samples: out, rules } = anonymizeSamples({
    samples: [
      { a: "same", b: "same" },
      { a: "same", b: "same" },
    ],
    rules: ["/a", "/b"],
  });
  assert.ok(rules.every((r) => r.status === "ok"));
  // Internally consistent within each rule.
  assert.equal(out[0].a, out[1].a);
  assert.equal(out[0].b, out[1].b);
  assert.notEqual(out[0].a, "same");
  assert.notEqual(out[0].b, "same");
});

test("anonymizeSamples refuses illegal pointers with 422 and per-rule stats", () => {
  for (const pattern of ["a/b", "/a~2b", "/a~", "~0", "/a~x"]) {
    assert.throws(
      () => anonymizeSamples({ samples: [{ a: 1 }], rules: [pattern] }),
      (err) =>
        err.status === 422 &&
        err.details.rules[0].status === "invalid" &&
        err.details.rules[0].hits === 0 &&
        /Pointer 非法/.test(err.details.rules[0].error) &&
        /规则 1/.test(err.message)
    );
  }
  // Valid rules alongside an illegal one are still matched and reported.
  try {
    anonymizeSamples({ samples: [{ a: 1, b: 2 }], rules: ["/a", "oops"] });
    assert.unreachable("should have thrown");
  } catch (err) {
    assert.equal(err.status, 422);
    assert.equal(err.details.rules[0].status, "ok");
    assert.equal(err.details.rules[0].hits, 1);
    assert.equal(err.details.rules[1].status, "invalid");
    assert.equal(err.details.totalSamples, 1);
  }
});

test("anonymizeSamples refuses hits on objects and arrays with 422", () => {
  assert.throws(
    () => anonymizeSamples({ samples: [{ address: { city: "x" } }], rules: ["/address"] }),
    (err) =>
      err.status === 422 &&
      err.details.rules[0].status === "non-scalar" &&
      /对象/.test(err.details.rules[0].error) &&
      /#\/0\/address/.test(err.details.rules[0].error)
  );
  assert.throws(
    () => anonymizeSamples({ samples: [{ tags: ["a"] }], rules: ["/tags"] }),
    (err) => err.status === 422 && /数组/.test(err.details.rules[0].error)
  );
  // A wildcard that reaches both scalars and an object is refused as well.
  assert.throws(
    () => anonymizeSamples({ samples: [{ a: 1, b: { c: 2 } }], rules: ["/*"] }),
    (err) => err.status === 422 && err.details.rules[0].status === "non-scalar"
  );
});

test("anonymizeSamples refuses different rules hitting the same path", () => {
  // Wildcard vs. literal overlapping on the same key.
  assert.throws(
    () => anonymizeSamples({ samples: [{ a: { b: 1, c: 2 } }], rules: ["/a/*", "/a/b"] }),
    (err) => {
      if (err.status !== 422) return false;
      const [r0, r1] = err.details.rules;
      return (
        r0.status === "conflict" &&
        r1.status === "conflict" &&
        r0.hits === 2 &&
        r1.hits === 1 &&
        /#\/0\/a\/b/.test(r0.error) &&
        /规则 2/.test(r0.error) &&
        /规则 1/.test(r1.error)
      );
    }
  );
  // Duplicate rules conflict everywhere they hit.
  assert.throws(
    () => anonymizeSamples({ samples: [{ a: 1 }], rules: ["/a", "/a"] }),
    (err) => err.status === 422 && err.details.rules.every((r) => r.status === "conflict")
  );
  // No overlap in any sample -> no conflict.
  const ok = anonymizeSamples({
    samples: [{ a: { c: 1 } }],
    rules: ["/a/*", "/a/b"],
  });
  assert.equal(ok.rules[0].hits, 1);
  assert.equal(ok.rules[1].hits, 0);
  // Overlap in a different sample than the first is still a conflict.
  assert.throws(
    () =>
      anonymizeSamples({
        samples: [{ a: { c: 1 } }, { a: { b: 2 } }],
        rules: ["/a/*", "/a/b"],
      }),
    (err) => err.status === 422 && /#\/1\/a\/b/.test(err.message)
  );
});

test("anonymizeSamples caps the reported paths per rule", () => {
  const samples = Array.from({ length: MAX_PATHS_PER_RULE + 10 }, (_, i) => ({ id: i }));
  const { rules } = anonymizeSamples({ samples, rules: ["/id"] });
  assert.equal(rules[0].hits, MAX_PATHS_PER_RULE + 10);
  assert.equal(rules[0].paths.length, MAX_PATHS_PER_RULE);
  assert.equal(rules[0].pathsTruncated, true);
  assert.equal(rules[0].paths[0], "#/0/id");
});

test("anonymizeSamples validates its input shape", () => {
  for (const samples of [undefined, null, "nope", [], 42]) {
    assert.throws(
      () => anonymizeSamples({ samples, rules: ["/a"] }),
      (err) => err.status === 400 && /'samples' array/.test(err.message)
    );
  }
  for (const rules of [undefined, null, "nope", [], 42]) {
    assert.throws(
      () => anonymizeSamples({ samples: [{ a: 1 }], rules }),
      (err) => err.status === 400 && /'rules' array/.test(err.message)
    );
  }
  assert.throws(
    () => anonymizeSamples({ samples: [{ a: 1 }], rules: ["/a", 42] }),
    (err) => err.status === 400 && /JSON Pointer string/.test(err.message)
  );
});

test(`anonymizeSamples rejects more than ${MAX_SAMPLES} samples with status 400`, () => {
  const samples = Array.from({ length: MAX_SAMPLES + 1 }, () => ({ a: 1 }));
  assert.throws(
    () => anonymizeSamples({ samples, rules: ["/a"] }),
    (err) => err.status === 400 && new RegExp(`${MAX_SAMPLES}`).test(err.message)
  );
  // Exactly at the limit is fine.
  const ok = anonymizeSamples({
    samples: Array.from({ length: MAX_SAMPLES }, (_, i) => ({ a: i })),
    rules: ["/a"],
  });
  assert.equal(ok.totalSamples, MAX_SAMPLES);
  assert.equal(ok.rules[0].hits, MAX_SAMPLES);
});
