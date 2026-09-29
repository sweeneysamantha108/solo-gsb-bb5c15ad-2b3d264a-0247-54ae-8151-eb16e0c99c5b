import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptResponse,
  isRunFresh,
  migrationSignature,
} from "../src/migrationBinding.js";

const BASELINE = { type: "object", properties: { phone: { type: "string" } } };
const CURRENT = {
  type: "object",
  properties: { contact: { type: "object", properties: { phone: { type: "string" } } } },
  required: ["contact"],
};

const inputs = (overrides = {}) => ({
  text: '[{"phone":"1"}]',
  mappings: [{ from: "/phone", to: "/contact/phone", defaultText: "" }],
  baselineSchema: BASELINE,
  currentSchema: CURRENT,
  ...overrides,
});

test("signature is stable for identical inputs and changes when the sample text changes", () => {
  const a = migrationSignature(inputs());
  const b = migrationSignature(inputs());
  assert.equal(a, b);
  assert.notEqual(a, migrationSignature(inputs({ text: '[{"phone":"2"}]' })));
});

test("signature changes when a mapping path or its default value changes", () => {
  const base = migrationSignature(inputs());
  assert.notEqual(
    base,
    migrationSignature(inputs({ mappings: [{ from: "/tel", to: "/contact/phone", defaultText: "" }] }))
  );
  assert.notEqual(
    base,
    migrationSignature(inputs({ mappings: [{ from: "/phone", to: "/contact/tel", defaultText: "" }] }))
  );
  assert.notEqual(
    base,
    migrationSignature(inputs({ mappings: [{ from: "/phone", to: "/contact/phone", defaultText: "null" }] }))
  );
  // Adding/removing a mapping row also breaks the binding.
  assert.notEqual(
    base,
    migrationSignature(
      inputs({
        mappings: [
          { from: "/phone", to: "/contact/phone", defaultText: "" },
          { from: "", to: "", defaultText: "" },
        ],
      })
    )
  );
});

test("signature changes when either schema version is replaced", () => {
  const base = migrationSignature(inputs());
  assert.notEqual(
    base,
    migrationSignature(inputs({ baselineSchema: { ...BASELINE, required: ["phone"] } }))
  );
  assert.notEqual(
    base,
    migrationSignature(inputs({ currentSchema: { ...CURRENT, required: ["contact", "extra"] } }))
  );
  assert.notEqual(base, migrationSignature(inputs({ baselineSchema: null })));
});

test("isRunFresh only trusts a non-null binding that still matches the inputs", () => {
  const sig = migrationSignature(inputs());
  assert.equal(isRunFresh(sig, sig), true);
  assert.equal(isRunFresh(null, sig), false);
  assert.equal(
    isRunFresh(sig, migrationSignature(inputs({ text: "[]" }))),
    false
  );
});

test("acceptResponse admits the latest request while inputs still match", () => {
  const sig = migrationSignature(inputs());
  assert.equal(acceptResponse(3, 3, sig, sig), true);
});

test("acceptResponse rejects an older request once a newer run started", () => {
  const sig = migrationSignature(inputs());
  assert.equal(acceptResponse(2, 3, sig, sig), false);
});

test("acceptResponse rejects the latest request when an input changed mid-flight", () => {
  const submitted = migrationSignature(inputs());
  const changed = migrationSignature(inputs({ text: '[{"phone":"9"}]' }));
  assert.equal(acceptResponse(3, 3, submitted, changed), false);
});
