import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGateReport,
  bumpType,
  compareSemver,
  evaluateGate,
  parseSemver,
} from "../src/gate.js";

const NO_CHANGES = { breaking: 0, compatible: 0, info: 0 };

test("parseSemver accepts plain versions and the v prefix", () => {
  assert.deepEqual(parseSemver("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
    build: null,
    normalized: "1.2.3",
  });
  assert.equal(parseSemver("v1.2.3").normalized, "1.2.3");
  assert.equal(parseSemver("V2.0.0").normalized, "2.0.0");
  assert.equal(parseSemver("  v10.20.30  ").normalized, "10.20.30");
});

test("parseSemver handles prerelease identifiers and build metadata", () => {
  const alpha = parseSemver("1.0.0-alpha");
  assert.deepEqual(alpha.prerelease, ["alpha"]);
  assert.equal(alpha.normalized, "1.0.0-alpha");

  const dotted = parseSemver("2.0.0-alpha.1.x-y");
  assert.deepEqual(dotted.prerelease, ["alpha", "1", "x-y"]);

  const withBuild = parseSemver("1.2.3-rc.1+build.05");
  assert.deepEqual(withBuild.prerelease, ["rc", "1"]);
  assert.equal(withBuild.build, "build.05");
  assert.equal(withBuild.normalized, "1.2.3-rc.1"); // build metadata not normalized
});

test("parseSemver rejects malformed versions", () => {
  for (const bad of [
    "",
    "   ",
    "1.2",
    "1.2.3.4",
    "v",
    "1.02.3",
    "1.2.3-",
    "1.2.3-alpha..1",
    "1.2.3-01",
    "1.2.3+",
    null,
    undefined,
    123,
  ]) {
    assert.equal(parseSemver(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("compareSemver orders the numeric triple", () => {
  const v = (s) => parseSemver(s);
  assert.equal(compareSemver(v("1.2.3"), v("1.2.4")), -1);
  assert.equal(compareSemver(v("1.2.4"), v("1.3.0")), -1);
  assert.equal(compareSemver(v("1.9.9"), v("2.0.0")), -1);
  assert.equal(compareSemver(v("2.0.0"), v("1.99.99")), 1);
  assert.equal(compareSemver(v("1.2.3"), v("v1.2.3")), 0);
});

test("compareSemver follows the semver.org prerelease precedence chain", () => {
  const chain = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ].map(parseSemver);
  for (let i = 0; i < chain.length - 1; i += 1) {
    assert.equal(compareSemver(chain[i], chain[i + 1]), -1, `${chain[i].normalized} < ${chain[i + 1].normalized}`);
    assert.equal(compareSemver(chain[i + 1], chain[i]), 1);
    assert.equal(compareSemver(chain[i], chain[i]), 0);
  }
});

test("compareSemver compares numeric identifiers numerically and ignores build metadata", () => {
  const v = (s) => parseSemver(s);
  assert.equal(compareSemver(v("1.0.0-alpha.2"), v("1.0.0-alpha.11")), -1);
  assert.equal(compareSemver(v("1.2.3+build.1"), v("1.2.3+build.2")), 0);
  assert.equal(compareSemver(v("1.2.3+build"), v("1.2.3")), 0);
});

test("bumpType classifies every move kind", () => {
  const bump = (a, b) => bumpType(parseSemver(a), parseSemver(b));
  assert.equal(bump("1.2.3", "2.0.0"), "major");
  assert.equal(bump("1.2.3", "2.0.0-alpha.1"), "major"); // prerelease tag keeps the major bump
  assert.equal(bump("1.2.3", "1.3.0"), "minor");
  assert.equal(bump("1.2.3", "1.2.4"), "patch");
  assert.equal(bump("1.2.3-alpha", "1.2.3"), "prerelease");
  assert.equal(bump("1.2.3-alpha", "1.2.3-beta"), "prerelease");
  assert.equal(bump("1.2.3", "v1.2.3"), "same");
  assert.equal(bump("1.2.3+build.1", "1.2.3+build.2"), "same");
  assert.equal(bump("2.0.0", "1.9.9"), "downgrade");
  assert.equal(bump("1.2.3", "1.2.3-alpha"), "downgrade"); // release -> its own prerelease
});

test("gate: breaking changes require a major bump", () => {
  const summary = { breaking: 2, compatible: 1, info: 0 };
  const allow = evaluateGate({
    baseVersion: "v1.2.3",
    targetVersion: "2.0.0",
    perspective: "request",
    summary,
  });
  assert.equal(allow.ok, true);
  assert.equal(allow.allowed, true);
  assert.equal(allow.bump, "major");
  assert.equal(allow.required, "major");
  assert.equal(allow.triggerCount, 2);
  assert.match(allow.reason, /破坏性变更/);

  for (const target of ["1.3.0", "1.2.4", "1.2.4-alpha"]) {
    const blocked = evaluateGate({
      baseVersion: "1.2.3",
      targetVersion: target,
      perspective: "request",
      summary,
    });
    assert.equal(blocked.allowed, false, `${target} must be blocked`);
    assert.match(blocked.reason, /仅主版本提升可放行/);
  }
});

test("gate: compatible-only changes require at least a minor bump", () => {
  const summary = { breaking: 0, compatible: 1, info: 1 };
  const minor = evaluateGate({
    baseVersion: "1.2.3",
    targetVersion: "1.3.0",
    perspective: "response",
    summary,
  });
  assert.equal(minor.allowed, true);
  assert.equal(minor.required, "minor");
  assert.equal(minor.triggerCount, 2);

  const major = evaluateGate({
    baseVersion: "1.2.3",
    targetVersion: "2.0.0",
    perspective: "response",
    summary,
  });
  assert.equal(major.allowed, true);

  const patch = evaluateGate({
    baseVersion: "1.2.3",
    targetVersion: "1.2.4",
    perspective: "response",
    summary,
  });
  assert.equal(patch.allowed, false);
  assert.match(patch.reason, /至少需次版本提升/);
});

test("gate: no contract changes allow a patch-level release", () => {
  for (const target of ["1.2.4", "1.3.0", "2.0.0"]) {
    const verdict = evaluateGate({
      baseVersion: "1.2.3",
      targetVersion: target,
      perspective: "request",
      summary: NO_CHANGES,
    });
    assert.equal(verdict.allowed, true, `${target} should be allowed`);
    assert.equal(verdict.required, "patch");
    assert.equal(verdict.triggerCount, 0);
  }
  // Graduating a prerelease on an unchanged contract is fine too.
  const graduated = evaluateGate({
    baseVersion: "1.2.3-alpha",
    targetVersion: "1.2.3",
    perspective: "request",
    summary: NO_CHANGES,
  });
  assert.equal(graduated.allowed, true);
  assert.equal(graduated.bump, "prerelease");
});

test("gate: same version and downgrades are always blocked", () => {
  const same = evaluateGate({
    baseVersion: "v1.2.3",
    targetVersion: "1.2.3",
    perspective: "request",
    summary: NO_CHANGES,
  });
  assert.equal(same.allowed, false);
  assert.equal(same.bump, "same");
  assert.match(same.reason, /同版本/);

  const sameWithBreaking = evaluateGate({
    baseVersion: "1.2.3",
    targetVersion: "1.2.3+other-build",
    perspective: "request",
    summary: { breaking: 3, compatible: 0, info: 0 },
  });
  assert.equal(sameWithBreaking.allowed, false);

  const downgrade = evaluateGate({
    baseVersion: "2.0.0",
    targetVersion: "1.9.9",
    perspective: "response",
    summary: NO_CHANGES,
  });
  assert.equal(downgrade.allowed, false);
  assert.equal(downgrade.bump, "downgrade");
  assert.match(downgrade.reason, /降级/);
});

test("gate: invalid versions yield input errors, not a verdict", () => {
  const one = evaluateGate({
    baseVersion: "abc",
    targetVersion: "1.2.3",
    perspective: "request",
    summary: NO_CHANGES,
  });
  assert.equal(one.ok, false);
  assert.equal(one.errors.length, 1);
  assert.match(one.errors[0], /基线版本/);

  const both = evaluateGate({
    baseVersion: "",
    targetVersion: "1.2",
    perspective: "request",
    summary: NO_CHANGES,
  });
  assert.equal(both.ok, false);
  assert.equal(both.errors.length, 2);
});

test("buildGateReport assembles versions, perspective, summary and decision", () => {
  const evaluation = evaluateGate({
    baseVersion: "v1.2.3",
    targetVersion: "2.0.0-alpha.1",
    perspective: "response",
    summary: { breaking: 1, compatible: 2, info: 0 },
  });
  const report = buildGateReport(evaluation);
  assert.equal(report.kind, "release-gate-report");
  assert.equal(report.perspective, "response");
  assert.deepEqual(report.versions, {
    base: { input: "v1.2.3", normalized: "1.2.3" },
    target: { input: "2.0.0-alpha.1", normalized: "2.0.0-alpha.1" },
  });
  assert.equal(report.bump, "major");
  assert.equal(report.requiredBump, "major");
  assert.deepEqual(report.summary, { breaking: 1, compatible: 2, info: 0, total: 3 });
  assert.equal(report.triggerCount, 1);
  assert.equal(report.decision, "allow");
  assert.ok(report.reason.length > 0);
  assert.ok(!Number.isNaN(Date.parse(report.generatedAt)));

  const blocked = buildGateReport(
    evaluateGate({
      baseVersion: "1.2.3",
      targetVersion: "1.2.3",
      perspective: "request",
      summary: NO_CHANGES,
    })
  );
  assert.equal(blocked.decision, "block");
});
