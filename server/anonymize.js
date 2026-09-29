"use strict";

/**
 * Anonymized export.
 *
 * The user configures one or more JSON Pointer patterns (RFC 6901 escaping,
 * plus a single-segment "*" wildcard that matches any object key or array
 * index). Every sample is walked recursively; each location a pattern
 * resolves to is a "hit". Hits on scalar values are replaced with pseudonyms
 * that are
 *
 *   - stable across samples: the same original value matched by the same
 *     rule always maps to the same replacement, anywhere in the export;
 *   - injective per rule: two different original values never share a
 *     replacement (the rare hash collision is resolved by re-seeding);
 *   - type preserving: strings stay strings, booleans stay booleans, null
 *     stays null, integers stay integers and floats stay non-integer.
 *
 * Generation is refused (422) when a pattern is not a legal JSON Pointer,
 * when a hit lands on an object or array, or when two different rules hit
 * the same path in the same sample. Refusals still carry the per-rule
 * statistics (hit counts, matched paths, error) so the UI can show them
 * next to the refusal message.
 *
 * A single run is capped at MAX_SAMPLES samples.
 */

const crypto = require("node:crypto");
const { parsePointer } = require("./variant");
const { escapePointer, setOwnKey } = require("./infer");

const MAX_SAMPLES = 200;
const MAX_PATHS_PER_RULE = 50;

const POINTER_HINT =
  'JSON Pointer 须以 "/" 开头，"~" 仅允许写作 ~0（表示 ~）或 ~1（表示 /）；单段 "*" 可通配任意对象键或数组下标';

// RFC 6901 array index: "0" or digits without a leading zero.
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

function isScalar(value) {
  return value === null || typeof value !== "object";
}

/**
 * Recursively collect every location where `segments` matches inside `node`.
 * A "*" segment matches any single object key or array index; any other
 * segment follows plain JSON Pointer evaluation (object property, or array
 * index when the segment is a canonical index). Matching stops silently at
 * scalars, missing keys and out-of-range indexes.
 *
 * @param {string[]} segments parsed pointer segments ("" root -> [])
 * @param {string[]} path unescaped key/index segments walked so far
 * @param {Array<{path: string[], value: any}>} hits accumulator
 */
function collectMatches(node, segments, segIndex, path, hits) {
  if (segIndex === segments.length) {
    hits.push({ path, value: node });
    return;
  }
  if (node === null || typeof node !== "object") return;
  const segment = segments[segIndex];
  if (Array.isArray(node)) {
    if (segment === "*") {
      node.forEach((item, index) => {
        collectMatches(item, segments, segIndex + 1, [...path, String(index)], hits);
      });
    } else if (ARRAY_INDEX.test(segment)) {
      const index = Number(segment);
      if (index < node.length) {
        collectMatches(node[index], segments, segIndex + 1, [...path, segment], hits);
      }
    }
    return;
  }
  if (segment === "*") {
    for (const key of Object.keys(node)) {
      collectMatches(node[key], segments, segIndex + 1, [...path, key], hits);
    }
    return;
  }
  if (Object.prototype.hasOwnProperty.call(node, segment)) {
    collectMatches(node[segment], segments, segIndex + 1, [...path, segment], hits);
  }
}

/** sha256 hex digest of the NUL-separated parts. */
function digestHex(parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(part), "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Deterministic type-preserving pseudonym for one scalar. `attempt` is
 * incremented by the caller whenever a candidate collides with a replacement
 * already handed out under the same rule, so different originals never merge.
 */
function pseudonym(pattern, value, attempt) {
  if (value === null) return null; // null has a single possible value
  switch (typeof value) {
    case "string":
      return `anon_${digestHex([pattern, "string", value, attempt]).slice(0, 12)}`;
    case "boolean":
      // The only injective boolean maps are identity and negation; negation
      // is the one that actually hides the original value.
      return !value;
    case "number": {
      const kind = Number.isInteger(value) ? "integer" : "number";
      const h = parseInt(digestHex([pattern, kind, value, attempt]).slice(0, 8), 16);
      const base = 100000000 + (h % 900000000); // 9-digit integer
      // Integers must never become floats; floats must never become integers.
      return Number.isInteger(value) ? base : base + 0.5;
    }
    default:
      return value; // unreachable: only scalars are replaced
  }
}

/** Set `value` at the location addressed by unescaped key/index segments. */
function setAtPath(container, segments, value) {
  let node = container;
  for (let i = 0; i < segments.length - 1; i += 1) node = node[segments[i]];
  const last = segments[segments.length - 1];
  // defineProperty: a "__proto__" segment is a normal JSON key, not the
  // prototype slot (segments above it were resolved as own properties).
  setOwnKey(node, last, value);
}

/**
 * Match every rule against every sample and replace the hit scalars with
 * stable, type-preserving pseudonyms.
 *
 * @returns {{ totalSamples: number,
 *            rules: Array<{ index: number, pattern: string, status: string,
 *                           hits: number, paths: string[],
 *                           pathsTruncated: boolean, error: string | null }>,
 *            samples: any[] }}
 */
function anonymizeSamples({ samples, rules }) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'samples' array."), {
      status: 400,
    });
  }
  if (samples.length > MAX_SAMPLES) {
    throw Object.assign(
      new Error(
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per export.`
      ),
      { status: 400 }
    );
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'rules' array."), {
      status: 400,
    });
  }
  for (const rule of rules) {
    if (typeof rule !== "string") {
      throw Object.assign(new Error("Every rule in 'rules' must be a JSON Pointer string."), {
        status: 400,
      });
    }
  }

  const stats = rules.map((pattern, index) => ({
    index,
    pattern,
    status: "ok", // "ok" | "invalid" | "non-scalar" | "conflict"
    hits: 0,
    paths: [],
    pathsTruncated: false,
    error: null,
  }));

  // Per-rule hits across all samples:
  // [{ sampleIndex, segments, pointer, value }], in deterministic walk order.
  const ruleHits = rules.map(() => []);

  rules.forEach((pattern, ruleIndex) => {
    const segments = parsePointer(pattern);
    if (segments === null) {
      stats[ruleIndex].status = "invalid";
      stats[ruleIndex].error = `Pointer 非法。${POINTER_HINT}`;
      return;
    }
    samples.forEach((sample, sampleIndex) => {
      const hits = [];
      collectMatches(sample, segments, 0, [], hits);
      for (const hit of hits) {
        const pointer = `#/${sampleIndex}${hit.path.map((seg) => `/${escapePointer(seg)}`).join("")}`;
        ruleHits[ruleIndex].push({
          sampleIndex,
          segments: hit.path,
          pointer,
          value: hit.value,
        });
      }
    });
  });

  // A hit on an object or array refuses the run: only scalars are replaced.
  ruleHits.forEach((hits, ruleIndex) => {
    if (stats[ruleIndex].status !== "ok") return;
    const bad = hits.find((hit) => !isScalar(hit.value));
    if (bad) {
      const kind = Array.isArray(bad.value) ? "数组" : "对象";
      stats[ruleIndex].status = "non-scalar";
      stats[ruleIndex].error = `命中${kind}（${bad.pointer}），仅支持替换标量值`;
    }
  });

  // Two different rules hitting the same path in the same sample refuse the
  // run (the display pointer already carries the sample index).
  const owner = new Map(); // display pointer -> first rule index that hit it
  ruleHits.forEach((hits, ruleIndex) => {
    for (const hit of hits) {
      const first = owner.get(hit.pointer);
      if (first === undefined) {
        owner.set(hit.pointer, ruleIndex);
      } else if (first !== ruleIndex) {
        for (const [self, other] of [
          [first, ruleIndex],
          [ruleIndex, first],
        ]) {
          if (stats[self].status === "ok") {
            stats[self].status = "conflict";
            stats[self].error =
              `与规则 ${other + 1}（${rules[other]}）命中同一路径 ${hit.pointer}`;
          }
        }
      }
    }
  });

  ruleHits.forEach((hits, ruleIndex) => {
    stats[ruleIndex].hits = hits.length;
    stats[ruleIndex].paths = hits.slice(0, MAX_PATHS_PER_RULE).map((hit) => hit.pointer);
    stats[ruleIndex].pathsTruncated = hits.length > MAX_PATHS_PER_RULE;
  });

  const problems = stats.filter((rule) => rule.status !== "ok");
  if (problems.length > 0) {
    const message = problems
      .map((rule) => `规则 ${rule.index + 1}（${rule.pattern}）：${rule.error}`)
      .join("；");
    throw Object.assign(new Error(`${message}。未生成匿名化样本。`), {
      status: 422,
      details: { totalSamples: samples.length, rules: stats },
    });
  }

  const anonymized = samples.map((sample) => JSON.parse(JSON.stringify(sample)));
  ruleHits.forEach((hits, ruleIndex) => {
    const pattern = rules[ruleIndex];
    const mapping = new Map(); // JSON.stringify(original) -> replacement
    const used = new Set(); // JSON.stringify(replacement)s handed out by this rule
    for (const hit of hits) {
      const key = JSON.stringify(hit.value);
      let replacement;
      if (mapping.has(key)) {
        replacement = mapping.get(key);
      } else {
        let attempt = 0;
        replacement = pseudonym(pattern, hit.value, attempt);
        while (used.has(JSON.stringify(replacement))) {
          attempt += 1;
          replacement = pseudonym(pattern, hit.value, attempt);
        }
        mapping.set(key, replacement);
        used.add(JSON.stringify(replacement));
      }
      if (hit.segments.length === 0) {
        anonymized[hit.sampleIndex] = replacement; // the whole sample is the hit
      } else {
        setAtPath(anonymized[hit.sampleIndex], hit.segments, replacement);
      }
    }
  });

  return { totalSamples: samples.length, rules: stats, samples: anonymized };
}

module.exports = { anonymizeSamples, pseudonym, MAX_SAMPLES, MAX_PATHS_PER_RULE, POINTER_HINT };
