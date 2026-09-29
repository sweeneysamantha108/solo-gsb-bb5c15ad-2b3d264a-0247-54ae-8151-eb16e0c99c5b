"use strict";

/**
 * Event variant contract builder.
 *
 * The user picks a JSON Pointer (RFC 6901) as the discriminator field. Every
 * sample is read at that position:
 *
 *   - string / number / boolean -> the sample joins the group for that value
 *   - missing field, or object / array / null -> the sample is skipped and
 *     reported with a reason (grouping only works on scalar discriminators)
 *   - illegally escaped pointer   -> every sample is skipped
 *
 * Each group is folded into a branch schema by the regular inference engine,
 * so `required` contains exactly the fields present in every sample of the
 * group. The discriminator is then pinned to the group's value with `const`
 * (required along the whole pointer path), which makes the branches mutually
 * exclusive; they are combined into a single `oneOf` contract. Fewer than two
 * valid groups means there is no variant to describe, so the build is refused
 * with status 422 — the response still carries the grouping analysis.
 */

const { inferSchema, syncProtoPattern, isProtoKey, setOwnKey } = require("./infer");

const MAX_SAMPLES = 200;

const POINTER_HINT =
  'JSON Pointer 须以 "/" 开头，"~" 仅允许写作 ~0（表示 ~）或 ~1（表示 /）';

/**
 * Parse a JSON Pointer into unescaped segments ("" root -> []).
 * Returns null when the pointer is malformed: not starting with "/" or
 * carrying an illegal "~" escape (RFC 6901 defines only ~0 and ~1).
 */
function parsePointer(pointer) {
  if (typeof pointer !== "string") return null;
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  const segments = [];
  for (const raw of pointer.slice(1).split("/")) {
    let segment = "";
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch !== "~") {
        segment += ch;
        continue;
      }
      const next = raw[i + 1];
      if (next === "0") segment += "~";
      else if (next === "1") segment += "/";
      else return null;
      i += 1;
    }
    segments.push(segment);
  }
  return segments;
}

const NOT_FOUND = Symbol("not-found");

/** Resolve pointer segments by walking object properties only. */
function resolvePointer(sample, segments) {
  let value = sample;
  for (const segment of segments) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return NOT_FOUND;
    }
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return NOT_FOUND;
    value = value[segment];
  }
  return value;
}

/**
 * Pin the discriminator to the group's value inside a branch schema: walk
 * (defensively creating) the properties chain and mark every segment required,
 * then set `const` on the reached node.
 */
function injectConst(schema, segments, value) {
  let node = schema;
  for (const segment of segments) {
    if (!node.properties || typeof node.properties !== "object") {
      node.properties = {};
    }
    if (
      !Object.prototype.hasOwnProperty.call(node.properties, segment) ||
      typeof node.properties[segment] !== "object" ||
      node.properties[segment] === null
    ) {
      // defineProperty: a "__proto__" segment is an ordinary JSON key here.
      setOwnKey(node.properties, segment, {});
    }
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    required.add(segment);
    node.required = [...required];
    // Pinning "__proto__" must reach the patternProperties alias Ajv
    // actually enforces, not only the literal properties entry it skips.
    if (isProtoKey(segment)) syncProtoPattern(node);
    node = node.properties[segment];
  }
  node.const = value;
}

/** Rewrite inference path-map entries (#/<local>/...) to global sample indexes. */
function remapPaths(paths, sampleIndexes) {
  const out = {};
  for (const [schemaPointer, samplePaths] of Object.entries(paths)) {
    out[schemaPointer] = samplePaths.map((p) =>
      p.replace(/^#\/(\d+)/, (_, i) => `#/${sampleIndexes[Number(i)]}`)
    );
  }
  return out;
}

/** Light group description used in refusal responses (no branch schemas). */
function groupSummary(group) {
  return {
    value: group.value,
    count: group.sampleIndexes.length,
    sampleIndexes: group.sampleIndexes,
  };
}

/**
 * Build a oneOf variant contract from samples grouped by a discriminator.
 *
 * @returns {{ pointer: string, totalSamples: number, validSamples: number,
 *            groupCount: number,
 *            groups: Array<{ value: any, count: number, sampleIndexes: number[],
 *                            schema: object, paths: object }>,
 *            skipped: Array<{ index: number, reason: string }>,
 *            schema: object }}
 */
function buildVariantContract({ samples, pointer }) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw Object.assign(new Error("Request body must contain a non-empty 'samples' array."), {
      status: 400,
    });
  }
  if (samples.length > MAX_SAMPLES) {
    throw Object.assign(
      new Error(
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per build.`
      ),
      { status: 400 }
    );
  }
  if (typeof pointer !== "string") {
    throw Object.assign(new Error("Request body must contain a 'pointer' string."), {
      status: 400,
    });
  }

  const segments = parsePointer(pointer);
  const groups = new Map(); // JSON.stringify(value) -> { value, sampleIndexes, samples }
  const skipped = [];

  samples.forEach((sample, index) => {
    if (segments === null) {
      skipped.push({ index, reason: "判别 Pointer 非法，未参与分组" });
      return;
    }
    const value = resolvePointer(sample, segments);
    if (value === NOT_FOUND) {
      skipped.push({ index, reason: "判别字段缺失" });
      return;
    }
    if (value === null || typeof value === "object") {
      const kind = value === null ? "null" : Array.isArray(value) ? "数组" : "对象";
      skipped.push({ index, reason: `判别字段值为${kind}，仅支持字符串 / 数字 / 布尔` });
      return;
    }
    // JSON.stringify keeps "1" (string), 1 (number) and true (boolean) apart.
    const key = JSON.stringify(value);
    let group = groups.get(key);
    if (!group) {
      group = { value, sampleIndexes: [], samples: [] };
      groups.set(key, group);
    }
    group.sampleIndexes.push(index);
    group.samples.push(sample);
  });

  const groupList = [...groups.values()];
  const base = {
    pointer,
    totalSamples: samples.length,
    validSamples: groupList.reduce((n, g) => n + g.samples.length, 0),
    groupCount: groupList.length,
    skipped,
  };

  if (segments === null) {
    throw Object.assign(
      new Error(`判别字段 Pointer 非法：${JSON.stringify(pointer)}。${POINTER_HINT}。`),
      { status: 422, details: { ...base, groups: groupList.map(groupSummary) } }
    );
  }
  if (groupList.length < 2) {
    throw Object.assign(
      new Error(`有效分组不足 2 个（当前 ${groupList.length} 个），无法生成事件变体契约。`),
      { status: 422, details: { ...base, groups: groupList.map(groupSummary) } }
    );
  }

  const branches = groupList.map((group) => {
    const { schema, paths } = inferSchema(group.samples);
    delete schema.$schema; // the draft marker lives on the top-level contract only
    injectConst(schema, segments, group.value);
    return {
      value: group.value,
      count: group.samples.length,
      sampleIndexes: group.sampleIndexes,
      schema,
      paths: remapPaths(paths, group.sampleIndexes),
    };
  });

  return {
    ...base,
    groups: branches,
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      oneOf: branches.map((b) => b.schema),
    },
  };
}

module.exports = { buildVariantContract, parsePointer, MAX_SAMPLES, POINTER_HINT };
