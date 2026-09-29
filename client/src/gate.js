/**
 * Release gate: SemVer 2.0.0 parsing/comparison plus the allow/block verdict
 * derived from a /api/diff summary.
 *
 * Pure module with no browser or React dependencies: the ReleaseGate component
 * and the node:test unit tests share it. The gate itself never calls the
 * server — it reuses the diff result the panel already fetched, so switching
 * perspective or editing a version recomputes instantly.
 *
 * Gate rules (per the contract-evolution policy):
 *  - breaking changes present   -> only a major bump may pass
 *  - only compatible/info edits -> at least a minor bump
 *  - no contract changes        -> patch-level release is fine
 *  - same version or a downgrade -> always blocked
 */

// Official semver.org grammar, plus an optional leading "v"/"V". Build
// metadata (+build) is parsed but ignored for precedence, per the spec.
const SEMVER_RE =
  /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const NUMERIC_ID = /^\d+$/;

export const BUMP_TYPES = ["major", "minor", "patch", "prerelease", "same", "downgrade"];

export const BUMP_LABELS = {
  major: "主版本提升",
  minor: "次版本提升",
  patch: "补丁发布",
  prerelease: "预发布递进",
  same: "同版本",
  downgrade: "版本降级",
};

export const REQUIRED_LABELS = {
  major: "主版本提升（存在破坏性变更）",
  minor: "至少次版本提升（存在兼容/提示级变更）",
  patch: "补丁级发布（无契约变化）",
};

// How far each bump type counts towards a requirement. A prerelease
// progression on the same numeric triple (1.2.3-alpha -> 1.2.3) ranks as
// patch-level: allowed when nothing changed, never enough for real changes.
const BUMP_RANK = { prerelease: 1, patch: 1, minor: 2, major: 3 };

/**
 * Parse a SemVer string, tolerating a leading "v" and surrounding whitespace.
 * @returns {{major:number, minor:number, patch:number, prerelease:string[],
 *   build:string|null, normalized:string} | null} null when invalid.
 */
export function parseSemver(input) {
  if (typeof input !== "string") return null;
  const match = SEMVER_RE.exec(input.trim());
  if (!match) return null;
  const [, major, minor, patch, pre, build] = match;
  const prerelease = pre ? pre.split(".") : [];
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease,
    build: build || null,
    normalized:
      `${Number(major)}.${Number(minor)}.${Number(patch)}` +
      (prerelease.length > 0 ? `-${prerelease.join(".")}` : ""),
  };
}

/**
 * SemVer 2.0.0 precedence: numeric triple first, then prerelease identifiers
 * (a prerelease sorts before its release). Build metadata is ignored.
 * @returns {-1 | 0 | 1}
 */
export function compareSemver(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  const preA = a.prerelease;
  const preB = b.prerelease;
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return 1; // release outranks any of its prereleases
  if (preB.length === 0) return -1;
  const shared = Math.min(preA.length, preB.length);
  for (let i = 0; i < shared; i += 1) {
    const idA = preA[i];
    const idB = preB[i];
    if (idA === idB) continue;
    const numA = NUMERIC_ID.test(idA);
    const numB = NUMERIC_ID.test(idB);
    if (numA && numB) {
      // No leading zeros allowed by the grammar, so length then lexicographic
      // compares numeric value without precision loss on huge identifiers.
      if (idA.length !== idB.length) return idA.length < idB.length ? -1 : 1;
      return idA < idB ? -1 : 1;
    }
    if (numA) return -1; // numeric identifiers sort below alphanumeric ones
    if (numB) return 1;
    return idA < idB ? -1 : 1;
  }
  if (preA.length === preB.length) return 0;
  return preA.length < preB.length ? -1 : 1; // shorter set loses when prefixed
}

/**
 * Classify the version move base -> target. Numeric triple decides the bump
 * kind; a same-triple move that only advances the prerelease chain is a
 * "prerelease" bump.
 */
export function bumpType(base, target) {
  const order = compareSemver(base, target);
  if (order === 0) return "same";
  if (order > 0) return "downgrade";
  if (target.major !== base.major) return "major";
  if (target.minor !== base.minor) return "minor";
  if (target.patch !== base.patch) return "patch";
  return "prerelease";
}

function invalidInput(field, value) {
  const shown = String(value ?? "").trim() || "(空)";
  return `${field}「${shown}」不是有效的 SemVer：需为 主版本.次版本.补丁号 结构，可带 v 前缀与预发布标识（如 v1.2.3、2.0.0-alpha.1）。`;
}

/**
 * Evaluate the release gate for one perspective.
 *
 * @param {object} input
 * @param {string} input.baseVersion SemVer of the baseline (current) contract
 * @param {string} input.targetVersion SemVer of the new contract
 * @param {"request" | "response"} input.perspective
 * @param {{breaking:number, compatible:number, info:number}} input.summary
 *   summary object from /api/diff
 * @returns either { ok:false, errors:string[] } or { ok:true, allowed, bump,
 *   required, triggerCount, reason, base, target, summary, ... }
 */
export function evaluateGate({ baseVersion, targetVersion, perspective, summary }) {
  const base = parseSemver(baseVersion);
  const target = parseSemver(targetVersion);
  const errors = [];
  if (!base) errors.push(invalidInput("基线版本", baseVersion));
  if (!target) errors.push(invalidInput("目标版本", targetVersion));
  if (errors.length > 0) return { ok: false, errors };

  const breaking = summary?.breaking ?? 0;
  const compatible = summary?.compatible ?? 0;
  const info = summary?.info ?? 0;
  const soft = compatible + info;
  const required = breaking > 0 ? "major" : soft > 0 ? "minor" : "patch";
  // The changes that force the verdict: breaking ones when present, else the
  // compatible/info ones; zero when the versions alone decide.
  const triggerCount = breaking > 0 ? breaking : soft;

  const bump = bumpType(base, target);
  let allowed;
  let reason;
  if (bump === "downgrade") {
    allowed = false;
    reason = `目标版本 ${target.normalized} 低于基线版本 ${base.normalized}，降级发布一律阻止。`;
  } else if (bump === "same") {
    allowed = false;
    reason = `目标版本与基线版本相同（${base.normalized}），同版本重复发布一律阻止。`;
  } else if (BUMP_RANK[bump] < BUMP_RANK[required]) {
    allowed = false;
    reason =
      required === "major"
        ? `存在 ${breaking} 处破坏性变更，仅主版本提升可放行；当前为${BUMP_LABELS[bump]}，请提升主版本号（如 ${base.major + 1}.0.0）。`
        : `存在 ${soft} 处兼容/提示级变更，至少需次版本提升；当前为${BUMP_LABELS[bump]}，请提升次版本号（如 ${base.major}.${base.minor + 1}.0）。`;
  } else {
    allowed = true;
    if (required === "major") {
      reason = `存在 ${breaking} 处破坏性变更，目标版本已提升主版本号（${base.normalized} → ${target.normalized}），符合放行条件。`;
    } else if (required === "minor") {
      reason = `存在 ${soft} 处兼容/提示级变更，目标版本满足至少次版本提升（${base.normalized} → ${target.normalized}），符合放行条件。`;
    } else {
      reason = `两版契约无变化，可补丁级发布；当前为${BUMP_LABELS[bump]}（${base.normalized} → ${target.normalized}），符合放行条件。`;
    }
  }

  return {
    ok: true,
    allowed,
    bump,
    required,
    triggerCount,
    reason,
    perspective,
    base,
    target,
    baseInput: baseVersion,
    targetInput: targetVersion,
    summary: { breaking, compatible, info, total: breaking + compatible + info },
  };
}

/**
 * Build the copyable JSON report for a successful evaluation: versions,
 * perspective, diff summary and the final decision in one object.
 */
export function buildGateReport(evaluation) {
  return {
    tool: "json-contract-studio",
    kind: "release-gate-report",
    generatedAt: new Date().toISOString(),
    perspective: evaluation.perspective,
    versions: {
      base: { input: evaluation.baseInput, normalized: evaluation.base.normalized },
      target: { input: evaluation.targetInput, normalized: evaluation.target.normalized },
    },
    bump: evaluation.bump,
    bumpLabel: BUMP_LABELS[evaluation.bump],
    requiredBump: evaluation.required,
    summary: evaluation.summary,
    triggerCount: evaluation.triggerCount,
    decision: evaluation.allowed ? "allow" : "block",
    reason: evaluation.reason,
  };
}
