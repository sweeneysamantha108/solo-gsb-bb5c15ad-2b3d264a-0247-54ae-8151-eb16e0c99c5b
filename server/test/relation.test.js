"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inferSchema } = require("../infer");
const {
  mineRelations,
  enhanceSchema,
  collectScopes,
  reduceImplications,
  makeRuleId,
  parseRuleId,
  MAX_SAMPLES,
  MIN_SUPPORT,
} = require("../relation");

function ids(group, kind) {
  const rules = kind === "implication" ? group.implications : group.exclusions;
  return rules.map((r) => `${r.a}${kind === "implication" ? "->" : "/"}${r.b}`);
}

test("collectScopes counts every object instance per pointer and array elements independently", () => {
  const samples = [
    { id: 1, list: [{ a: 1, b: 2 }, { a: 3 }] },
    { id: 2, list: [{ a: 4 }] },
  ];
  const { scopes, pointerOrder } = collectScopes(samples);
  // 2 root objects + 3 item objects = 5 scopes.
  assert.equal(scopes.length, 5);
  assert.deepEqual(pointerOrder, ["", "/properties/list/items"]);

  const roots = scopes.filter((s) => s.pointer === "");
  assert.deepEqual(
    roots.map((s) => [...s.present].sort()),
    [
      ["id", "list"],
      ["id", "list"],
    ]
  );

  const items = scopes.filter((s) => s.pointer === "/properties/list/items");
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((s) => s.path), ["#/0/list/0", "#/0/list/1", "#/1/list/0"]);
  assert.deepEqual([...items[0].present].sort(), ["a", "b"]);
  assert.deepEqual([...items[1].present], ["a"]);
  // Item fields never leak into the root scope (no cross-scope association).
  for (const root of roots) {
    assert.equal(root.present.has("a"), false);
    assert.equal(root.present.has("b"), false);
  }
});

test("collectScopes treats nested object fields as their own scope", () => {
  const samples = [{ addr: { city: "x", zip: "1" } }, { addr: { city: "y" } }];
  const { scopes, pointerOrder } = collectScopes(samples);
  assert.deepEqual(pointerOrder, ["", "/properties/addr"]);
  const addrScopes = scopes.filter((s) => s.pointer === "/properties/addr");
  assert.equal(addrScopes.length, 2);
  assert.deepEqual([...addrScopes[0].present].sort(), ["city", "zip"]);
});

test("collectScopes ignores scalars and nulls at object scope positions", () => {
  const { scopes } = collectScopes([1, "x", null, true]);
  assert.equal(scopes.length, 0);
});

test("mineRelations reports implication candidates with support>=2 and 100% confidence", () => {
  const samples = [
    { id: 1, phone: "a", home: "h" },
    { id: 2, phone: "b", home: "i" },
    { id: 3 },
  ];
  const mined = mineRelations({ samples });
  assert.equal(mined.sampleCount, 3);
  assert.equal(mined.scopeCount, 3);
  const root = mined.scopes.find((g) => g.scopePointer === "");
  // {phone, home} is a 2-node SCC; both imply id. The SCC keeps its cycle
  // plus one representative edge to id (smallest first-seen field pair).
  assert.deepEqual(
    ids(root, "implication").sort(),
    ["home->phone", "phone->home", "phone->id"]
  );
  const phoneImpliesHome = root.implications.find((r) => r.a === "phone" && r.b === "home");
  assert.equal(phoneImpliesHome.support, 2);
  assert.equal(phoneImpliesHome.confidence, 1);
  assert.deepEqual(phoneImpliesHome.sampleIndexes, [0, 1]);
  assert.deepEqual(phoneImpliesHome.witnessPaths, ["#/0", "#/1"]);
});

test("mineRelations requires support >= 2 for implications", () => {
  const samples = [
    { id: 1, rare: "x", b: 1 },
    { id: 2 },
    { id: 3 },
  ];
  const root = mineRelations({ samples }).scopes[0];
  // "rare" only appears once: even though rare->id holds, support is 1.
  assert.equal(root.implications.some((r) => r.a === "rare"), false);
});

test("mineRelations drops implications with a counterexample", () => {
  const samples = [
    { a: 1, b: 2 },
    { a: 3 },
  ];
  const root = mineRelations({ samples }).scopes[0];
  assert.equal(root.implications.some((r) => r.a === "a" && r.b === "b"), false);
  // b -> a does hold with support 1, still below the threshold -> no rules.
  assert.equal(root.implications.length, 0);
});

test("mineRelations reports mutually exclusive pairs with per-side support >= 2", () => {
  const samples = [
    { a: 1, b: 2 },
    { a: 3, b: 4 },
    { c: true },
    { c: false },
  ];
  const root = mineRelations({ samples }).scopes[0];
  const pairs = ids(root, "exclusion");
  assert.ok(pairs.includes("a/c"));
  assert.ok(pairs.includes("b/c"));
  assert.equal(pairs.includes("a/b"), false); // co-occur
  const ac = root.exclusions.find((r) => r.a === "a" && r.b === "c");
  assert.equal(ac.support, 2);
  assert.equal(ac.countA, 2);
  assert.equal(ac.countB, 2);
  assert.equal(ac.coOccurrence, 0);
  assert.deepEqual(ac.witnessPathsA, ["#/0", "#/1"]);
  assert.deepEqual(ac.witnessPathsB, ["#/2", "#/3"]);
});

test("mineRelations does not report exclusions when one side has support 1", () => {
  const samples = [{ a: 1 }, { b: 2 }, { a: 3 }];
  const root = mineRelations({ samples }).scopes[0];
  assert.deepEqual(root.exclusions, []);
});

test("mineRelations mines independently inside array item scopes", () => {
  const samples = [
    { list: [{ a: 1, b: 2 }, { a: 3, b: 4 }] },
    { list: [{ a: 5 }] },
  ];
  const mined = mineRelations({ samples });
  const items = mined.scopes.find((g) => g.scopePointer === "/properties/list/items");
  assert.equal(items.scopeCount, 3);
  // b appears only alongside a (support 2); a also appears alone, so the
  // implication is one-directional.
  assert.deepEqual(ids(items, "implication"), ["b->a"]);
  const rule = items.implications[0];
  assert.equal(rule.support, 2);
  // Witnesses are observation paths inside the samples, with global indexes.
  assert.deepEqual(rule.witnessPaths, ["#/0/list/0", "#/0/list/1"]);
  assert.deepEqual(rule.sampleIndexes, [0]);
});

test("mineRelations never associates fields across scopes", () => {
  // Field "a" only ever appears in items; field "b" only ever at the root:
  // the two must not be compared to each other at all.
  const samples = [{ b: 1, list: [{ a: 1 }, { a: 2 }] }, { b: 2, list: [{ a: 3 }] }];
  const mined = mineRelations({ samples });
  for (const group of mined.scopes) {
    for (const rule of [...group.implications, ...group.exclusions]) {
      const fields = [rule.a, rule.b].sort().join();
      assert.notEqual(fields, "a,b");
    }
  }
});

test("reduceImplications drops transitive edges on a DAG chain", () => {
  // Nodes: A(0) -> B(1) -> C(2), plus A -> C directly.
  const kept = reduceImplications(["A", "B", "C"], [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
    { from: 0, to: 2 },
  ]);
  assert.deepEqual(kept, [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
  ]);
});

test("reduceImplications keeps one directed cycle for an equivalence SCC", () => {
  // A <-> B plus both imply C; the SCC keeps the 2-cycle A->B, B->A and one
  // representative edge B->C (A->C is transitively implied).
  const kept = reduceImplications(["A", "B", "C"], [
    { from: 0, to: 1 },
    { from: 1, to: 0 },
    { from: 0, to: 2 },
    { from: 1, to: 2 },
  ]);
  assert.deepEqual(
    kept.map((e) => `${e.from}${e.to}`).sort(),
    ["01", "02", "10"]
  );
});

test("mineRelations reports the number of edges removed by transitive reduction", () => {
  const samples = [
    { a: 1, b: 2, c: 3 },
    { a: 4, b: 5, c: 6 },
  ];
  const mined = mineRelations({ samples });
  // 6 raw pairwise implications (clique over 3 fields); reduction keeps 3
  // cycle edges, so 3 are removed.
  assert.equal(mined.summary.removedByTransitiveReduction, 3);
  assert.equal(mined.scopes[0].implications.length, 3);
});

test("mineRelations flags rules already enforced by plain required", () => {
  const samples = [
    { id: 1, a: 1, b: 2 },
    { id: 2, a: 3, b: 4 },
    { id: 3 },
  ];
  const { schema } = inferSchema(samples);
  const root = mineRelations({ samples, schema }).scopes[0];
  // id is required everywhere; a/b always co-occur (2-node SCC).
  const aToId = root.implications.find((r) => r.a === "a" && r.b === "id");
  assert.equal(aToId.alreadyEnforced, true);
  const aToB = root.implications.find((r) => r.a === "a" && r.b === "b");
  assert.equal(aToB.alreadyEnforced, false);
});

test("mineRelations scopes each carry field presence counts", () => {
  const samples = [{ a: 1, b: 2 }, { a: 3 }, { c: 1 }];
  const group = mineRelations({ samples }).scopes[0];
  assert.deepEqual(group.fields, [
    { name: "a", count: 2 },
    { name: "b", count: 1 },
    { name: "c", count: 1 },
  ]);
});

test("enhanceSchema injects dependentRequired and not/required for the picked rules", () => {
  const samples = [
    { id: 1, a: 1, b: 2 },
    { id: 2, a: 3, b: 4 },
    { id: 3, c: true },
    { id: 4, c: false },
  ];
  const { schema } = inferSchema(samples);
  const mined = mineRelations({ samples, schema });
  const root = mined.scopes[0];
  const ruleIds = [
    ...root.implications.filter((r) => !r.alreadyEnforced).map((r) => r.id),
    ...root.exclusions.map((r) => r.id),
  ];
  const out = enhanceSchema({ schema, samples, ruleIds });

  assert.equal(out.ruleCount, ruleIds.length);
  assert.equal(out.sampleCount, 4);
  assert.deepEqual(out.schema.dependentRequired, { a: ["b"], b: ["a"] });
  assert.deepEqual(out.schema.allOf, [
    { not: { required: ["a", "c"] } },
    { not: { required: ["b", "c"] } },
  ]);
  assert.equal(out.schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("enhanceSchema merges multiple implications sharing the same antecedent", () => {
  // a always comes with both b and c; b and c are independent otherwise, so
  // neither a->b nor a->c is transitively implied by the other.
  const samples = [
    { a: 1, b: 2, c: 3 },
    { a: 4, b: 5, c: 6 },
    { b: 7 },
    { c: 8 },
  ];
  const mined = mineRelations({ samples }).scopes[0];
  const aRules = mined.implications.filter((r) => r.a === "a").map((r) => r.id);
  assert.deepEqual(
    aRules.map((id) => parseRuleId(id)).sort((x, y) => (x.b < y.b ? -1 : 1)),
    [
      { kind: "implication", scopePointer: "", a: "a", b: "b" },
      { kind: "implication", scopePointer: "", a: "a", b: "c" },
    ]
  );
  const { schema } = inferSchema(samples);
  const out = enhanceSchema({ schema, samples, ruleIds: aRules });
  assert.deepEqual(out.schema.dependentRequired.a, ["b", "c"]);
});

test("enhanceSchema places rules on nested and array item scopes", () => {
  const samples = [
    { list: [{ a: 1, b: 2 }, { a: 3, b: 4 }] },
    { list: [{ a: 5, b: 6 }] },
  ];
  const { schema } = inferSchema(samples);
  const group = mineRelations({ samples }).scopes.find(
    (g) => g.scopePointer === "/properties/list/items"
  );
  const ruleIds = group.implications.map((r) => r.id);
  const out = enhanceSchema({ schema, samples, ruleIds });
  assert.deepEqual(out.schema.properties.list.items.dependentRequired, {
    a: ["b"],
    b: ["a"],
  });
});

test("enhanceSchema rejects documents that violate the mined rules", () => {
  const samples = [
    { a: 1, b: 2 },
    { a: 3, b: 4 },
    { c: 1 },
    { c: 2 },
  ];
  const { schema } = inferSchema(samples);
  const ruleIds = [makeRuleId("exclusion", "", "a", "c"), makeRuleId("implication", "", "a", "b")];
  const out = enhanceSchema({ schema, samples, ruleIds });
  const Ajv2020 = require("ajv/dist/2020").default;
  const validate = new Ajv2020({ strict: false }).compile(out.schema);
  assert.equal(validate({ a: 1, b: 2 }), true);
  assert.equal(validate({ c: 1 }), true);
  assert.equal(validate({ a: 1 }), false); // dependentRequired
  assert.equal(validate({ a: 1, b: 2, c: 3 }), false); // not/required
});

test("mineRelations treats __proto__ as an ordinary own field", () => {
  // JSON.parse (the HTTP body parser) stores "__proto__" as an own key.
  const samples = [
    JSON.parse(`{"__proto__":1,"b":2}`),
    JSON.parse(`{"__proto__":3,"b":4}`),
    { c: 5 },
  ];
  const root = mineRelations({ samples }).scopes[0];
  const edges = root.implications.map((r) => `${r.a}->${r.b}`).sort();
  assert.deepEqual(edges, ["__proto__->b", "b->__proto__"]);
  const fwd = root.implications.find((r) => r.a === "__proto__");
  assert.equal(fwd.support, 2);
  assert.deepEqual(fwd.sampleIndexes, [0, 1]);
});

test("enhanceSchema enforces __proto__ implications by own-key presence (both directions)", () => {
  // Samples twice contain both "__proto__" and "b"; a third contains neither.
  // Selecting "__proto__ -> b" must reject a document carrying only
  // "__proto__", and selecting "b -> __proto__" must reject one carrying only
  // "b" — presence is judged on the instance's own key, never the inherited
  // prototype slot. The check must hold even when the consuming validator does
  // not enable Ajv's ownProperties option.
  const Ajv2020 = require("ajv/dist/2020").default;
  const samples = [
    JSON.parse(`{"__proto__":1,"b":2}`),
    JSON.parse(`{"__proto__":3,"b":4}`),
    { c: 5 },
  ];
  const { schema } = inferSchema(samples);
  const mined = mineRelations({ samples, schema });
  const fwd = mined.scopes[0].implications.find((r) => r.a === "__proto__" && r.b === "b");
  const rev = mined.scopes[0].implications.find((r) => r.a === "b" && r.b === "__proto__");

  for (const ajvOpts of [{ strict: false }, { strict: false, ownProperties: true }]) {
    for (const [rule, violating] of [
      [fwd, JSON.parse(`{"__proto__":9}`)],
      [rev, JSON.parse(`{"b":9}`)],
    ]) {
      const out = enhanceSchema({ schema, samples, ruleIds: [rule.id] });
      const validate = new Ajv2020(ajvOpts).compile(out.schema);
      assert.equal(validate(violating), false); // new violating sample rejected
      assert.equal(validate(JSON.parse(`{"__proto__":9,"b":8}`)), true);
      assert.equal(validate({}), true); // neither key present: rule vacuous
      // every original sample still passes
      for (const sample of samples) assert.equal(validate(sample), true);
    }
  }
});

test("enhanceSchema does not emit dependentRequired for __proto__ rules", () => {
  // Ajv skips a literal dependentRequired["__proto__"] entry; the portable
  // own-key encoding lives in allOf instead, while ordinary fields are
  // untouched.
  const samples = [
    JSON.parse(`{"__proto__":1,"b":2}`),
    JSON.parse(`{"__proto__":3,"b":4}`),
    { c: 5 },
  ];
  const { schema } = inferSchema(samples);
  const mined = mineRelations({ samples, schema });
  const fwd = mined.scopes[0].implications.find((r) => r.a === "__proto__");
  const out = enhanceSchema({ schema, samples, ruleIds: [fwd.id] });
  assert.equal(out.schema.dependentRequired, undefined);
  assert.ok(Array.isArray(out.schema.allOf));
  assert.equal(out.schema.allOf.length, 1);
  assert.ok(out.schema.allOf[0].if);
  assert.ok(out.schema.allOf[0].then);
});

test("enhanceSchema counts an own __proto__:null as present, regardless of value", () => {
  // Relation mining observes key presence; a null own "__proto__" still counts.
  const Ajv2020 = require("ajv/dist/2020").default;
  const samples = [
    JSON.parse(`{"__proto__":null,"b":2}`),
    JSON.parse(`{"__proto__":3,"b":4}`),
    { c: 5 },
  ];
  const { schema } = inferSchema(samples);
  const mined = mineRelations({ samples, schema });
  const fwd = mined.scopes[0].implications.find((r) => r.a === "__proto__");
  const rev = mined.scopes[0].implications.find((r) => r.b === "__proto__");
  const vFwd = new Ajv2020({ strict: false }).compile(
    enhanceSchema({ schema, samples, ruleIds: [fwd.id] }).schema
  );
  const vRev = new Ajv2020({ strict: false }).compile(
    enhanceSchema({ schema, samples, ruleIds: [rev.id] }).schema
  );
  assert.equal(vFwd(JSON.parse(`{"__proto__":null}`)), false); // antecedent present, b missing
  assert.equal(vRev(JSON.parse(`{"b":8,"__proto__":null}`)), true); // consequent present
});

test("enhanceSchema enforces __proto__ rules inside nested and array-item scopes", () => {
  const Ajv2020 = require("ajv/dist/2020").default;
  const ajv = new Ajv2020({ strict: false });

  const nested = [
    JSON.parse(`{"o":{"__proto__":1,"b":2}}`),
    JSON.parse(`{"o":{"__proto__":3,"b":4}}`),
    JSON.parse(`{"o":{"c":5}}`),
  ];
  let schema = inferSchema(nested).schema;
  let ids = mineRelations({ samples: nested, schema }).scopes.flatMap((g) =>
    g.implications.map((r) => r.id)
  );
  let validate = ajv.compile(enhanceSchema({ schema, samples: nested, ruleIds: ids }).schema);
  assert.equal(validate(JSON.parse(`{"o":{"__proto__":9}}`)), false);
  assert.equal(validate(JSON.parse(`{"o":{"b":9}}`)), false);
  assert.equal(validate(JSON.parse(`{"o":{"__proto__":9,"b":8}}`)), true);

  const items = [
    JSON.parse(`{"list":[{"__proto__":1,"b":2},{"__proto__":3,"b":4},{"c":5}]}`),
  ];
  schema = inferSchema(items).schema;
  ids = mineRelations({ samples: items, schema }).scopes.flatMap((g) =>
    g.implications.map((r) => r.id)
  );
  validate = ajv.compile(enhanceSchema({ schema, samples: items, ruleIds: ids }).schema);
  assert.equal(validate(JSON.parse(`{"list":[{"__proto__":9}]}`)), false);
  assert.equal(validate(JSON.parse(`{"list":[{"b":9}]}`)), false);
  assert.equal(validate(JSON.parse(`{"list":[{"__proto__":9,"b":8}]}`)), true);
});

test("enhanceSchema encodes __proto__ exclusions by own-key presence", () => {
  // not/required would see the inherited prototype as a present "__proto__" and
  // wrongly reject a document that only contains "b".
  const Ajv2020 = require("ajv/dist/2020").default;
  const samples = [
    JSON.parse(`{"__proto__":1}`),
    JSON.parse(`{"__proto__":2}`),
    { b: 3 },
    { b: 4 },
  ];
  const { schema } = inferSchema(samples);
  const id = mineRelations({ samples, schema }).scopes[0].exclusions[0].id;
  const validate = new Ajv2020({ strict: false }).compile(
    enhanceSchema({ schema, samples, ruleIds: [id] }).schema
  );
  assert.equal(validate(JSON.parse(`{"__proto__":1,"b":2}`)), false);
  assert.equal(validate(JSON.parse(`{"__proto__":1}`)), true);
  assert.equal(validate({ b: 2 }), true); // must not false-positive on the prototype
  assert.equal(validate({}), true);
});

test("enhanceSchema refuses (422, no schema) when an original sample fails Ajv", () => {
  // The implication holds on the samples, but the supplied schema rejects
  // them via an unrelated constraint, simulating schema/sample drift.
  const schema = {
    type: "object",
    properties: { a: { type: "integer", minimum: 100 }, b: { type: "integer" } },
  };
  assert.throws(
    () =>
      enhanceSchema({
        schema,
        samples: [
          { a: 1, b: 2 },
          { a: 3, b: 4 },
        ],
        ruleIds: [makeRuleId("implication", "", "a", "b"), makeRuleId("implication", "", "b", "a")],
      }),
    (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /复验/);
      assert.equal(err.details.failures.length, 2);
      assert.equal(err.details.failures[0].errors[0].keyword, "minimum");
      return true;
    }
  );
});

test("enhanceSchema refuses unknown or stale rule ids with per-id reasons", () => {
  const samples = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  const { schema } = inferSchema(samples);
  const staleId = makeRuleId("implication", "", "nope", "zzz");
  try {
    enhanceSchema({ schema, samples, ruleIds: [staleId] });
    assert.unreachable("should have thrown");
  } catch (err) {
    assert.equal(err.status, 422);
    assert.equal(err.details.invalidRules.length, 1);
    assert.equal(err.details.invalidRules[0].id, staleId);
  }
});

test("enhanceSchema rejects ids from the pre-framing id format as stale", () => {
  const samples = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  const { schema } = inferSchema(samples);
  try {
    enhanceSchema({ schema, samples, ruleIds: ["implication||a->b"] });
    assert.unreachable("should have thrown");
  } catch (err) {
    assert.equal(err.status, 422);
    assert.equal(err.details.invalidRules.length, 1);
  }
});

test("enhanceSchema deduplicates repeated rule ids", () => {
  const samples = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  const { schema } = inferSchema(samples);
  const id = makeRuleId("implication", "", "a", "b");
  const out = enhanceSchema({ schema, samples, ruleIds: [id, id] });
  assert.equal(out.ruleCount, 1);
  assert.deepEqual(out.ruleIds, [id]);
});

test("rule ids keep RFC 6901 special characters and special tokens distinguishable", () => {
  const samples = [
    { "a/b": 1, "c~d": 2 },
    { "a/b": 3, "c~d": 4 },
  ];
  const { schema } = inferSchema(samples);
  const mined = mineRelations({ samples }).scopes[0];
  const rule = mined.implications.find((r) => r.a === "a/b" && r.b === "c~d");
  const id = rule.id;
  // Raw names are carried verbatim inside their length frames — RFC 6901
  // escapes are never re-applied to the framed field payload, so "a/b" and
  // "a~1b" cannot be confused for one another.
  assert.ok(id.includes("3:a/b"));
  assert.ok(id.includes("3:c~d"));
  assert.ok(!id.includes("a~1b"));
  assert.ok(!id.includes("c~0d"));
  // These fields are root keys, so the scope is the empty root pointer.
  assert.deepEqual(parseRuleId(id), {
    kind: "implication",
    scopePointer: "",
    a: "a/b",
    b: "c~d",
  });
  const out = enhanceSchema({ schema, samples, ruleIds: [id] });
  assert.deepEqual(out.schema.dependentRequired, { "a/b": ["c~d"] });
});

test("rule ids frame RFC 6901 escapes inside nested scope pointers", () => {
  // A nested object whose own key contains "/" and "~": the scope pointer
  // addresses that node with 6901 escapes while the framed fields stay raw.
  const samples = [
    { "x/y": { "a/b": 1, c: 2 } },
    { "x/y": { "a/b": 3, c: 4 } },
  ];
  const mined = mineRelations({ samples }).scopes.find(
    (g) => g.scopePointer === "/properties/x~1y"
  );
  assert.ok(mined);
  const rule = mined.implications.find((r) => r.a === "a/b" && r.b === "c");
  assert.ok(rule);
  assert.ok(rule.id.includes("16:/properties/x~1y"));
  assert.deepEqual(parseRuleId(rule.id), {
    kind: "implication",
    scopePointer: "/properties/x~1y",
    a: "a/b",
    b: "c",
  });
});

test("rule ids never collide for field names carrying |, ->, <x> or 6901 escapes", () => {
  // The exact collision from the bug report: ("a->b" -> c) and (a -> "b->c")
  // share one scope. The old separator-based id gave both "implication||a->b->c".
  const samples = [
    { "a->b": 1, c: 2 },
    { "a->b": 3, c: 4 },
    { a: 5, "b->c": 6 },
    { a: 7, "b->c": 8 },
  ];
  const { schema } = inferSchema(samples);
  const root = mineRelations({ samples, schema }).scopes[0];

  const firstEdge = root.implications.find((r) => r.a === "a->b" && r.b === "c");
  const secondEdge = root.implications.find((r) => r.a === "a" && r.b === "b->c");
  assert.ok(firstEdge && secondEdge);
  assert.notEqual(firstEdge.id, secondEdge.id);

  // Ticking the first edge must apply ONLY dependentRequired["a->b"]=["c"] and
  // must not impose the unrelated a -> b->c constraint.
  const out = enhanceSchema({ schema, samples, ruleIds: [firstEdge.id] });
  assert.deepEqual(out.rules.map((r) => [r.a, r.b]), [["a->b", "c"]]);
  assert.deepEqual(out.schema.dependentRequired, { "a->b": ["c"] });

  const Ajv2020 = require("ajv/dist/2020").default;
  const validate = new Ajv2020({ strict: false }).compile(out.schema);
  assert.equal(validate({ "a->b": 1, c: 2 }), true); // satisfies the picked rule
  assert.equal(validate({ "a->b": 1 }), false); // violates picked a->b => c
  // A document that only violates the NOT-picked a -> b->c edge must still
  // pass: the enhancer never applies the relation the user did not select.
  assert.equal(validate({ a: 5 }), true);
});

test("makeRuleId is injective over kind/scope/two fields and parseRuleId inverts it", () => {
  const names = [
    "a",
    "",
    "a->b",
    "a|b",
    "a<x>b",
    "a/b",
    "a~b",
    "a~1b",
    "a~0b",
    "1:ab",
    "0:",
    "12:abc|imp|",
    "->",
    "<x>",
    ":",
    "p|q->r<x>s~/",
  ];
  const pointers = ["", "/properties/a|x", "/properties/a~1b", "|", "0:|->"];
  const seen = new Set();
  let count = 0;
  for (const kind of ["implication", "exclusion"]) {
    for (const scope of pointers) {
      for (const a of names) {
        for (const b of names) {
          if (a === b) continue;
          const id = makeRuleId(kind, scope, a, b);
          assert.equal(seen.has(id), false, `collision on ${id}`);
          seen.add(id);
          assert.deepEqual(parseRuleId(id), { kind, scopePointer: scope, a, b });
          count += 1;
        }
      }
    }
  }
  assert.ok(count > 0);
  for (const bad of [
    "implication||a->b", // old separator-based format
    "implication|0|1:a->1:b", // missing colon after pointer length
    "bogus|0:|1:a->1:b", // unknown kind
    "implication|0:|1:a<x>1:b", // wrong field join for the kind
    "implication|0:|1:a-1:b", // missing join
    "implication|x:|1:a->1:b", // non-numeric length
    "implication|0:|3:ab->1:b", // declared length overruns the field
    "implication|0:|1:a->1:b|", // trailing junk
    "",
    null,
    42,
  ]) {
    assert.equal(parseRuleId(bad), null);
  }
});

test("mineRelations validates its input shape and sample cap", () => {
  for (const bad of [undefined, null, [], "x", 42]) {
    assert.throws(() => mineRelations({ samples: bad }), (err) => err.status === 400);
  }
  assert.throws(
    () => mineRelations({ samples: Array.from({ length: MAX_SAMPLES + 1 }, () => ({})) }),
    (err) => err.status === 400 && new RegExp(MAX_SAMPLES).test(err.message)
  );
  assert.throws(
    () => mineRelations({ samples: [{}], schema: [] }),
    (err) => err.status === 400 && /'schema' object/.test(err.message)
  );
});

test("mineRelations at the sample cap succeeds and finds no rules on empty objects", () => {
  const out = mineRelations({
    samples: Array.from({ length: MAX_SAMPLES }, () => ({})),
  });
  assert.equal(out.sampleCount, MAX_SAMPLES);
  assert.equal(out.summary.implication, 0);
  assert.equal(out.summary.exclusion, 0);
});

test("enhanceSchema validates its input shape", () => {
  assert.throws(
    () => enhanceSchema({ schema: null, samples: [{}], ruleIds: [] }),
    (err) => err.status === 400 && /'schema' object/.test(err.message)
  );
  assert.throws(
    () => enhanceSchema({ schema: {}, samples: [], ruleIds: [] }),
    (err) => err.status === 400 && /'samples' array/.test(err.message)
  );
  assert.throws(
    () => enhanceSchema({ schema: {}, samples: [{}] }),
    (err) => err.status === 400 && /'ruleIds' array/.test(err.message)
  );
  assert.throws(
    () => enhanceSchema({ schema: {}, samples: [{}], ruleIds: [42] }),
    (err) => err.status === 400 && /rule id/.test(err.message)
  );
});

test("MIN_SUPPORT is exactly 2", () => {
  assert.equal(MIN_SUPPORT, 2);
});
