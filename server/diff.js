"use strict";

/**
 * Contract evolution comparator.
 *
 * Recursively diffs two JSON Schemas (old baseline vs. new version) and
 * classifies every change by compatibility under one of two perspectives:
 *
 *  - "request"  (client -> server): the schema validates request bodies.
 *    Breaking: newly required fields, narrowed accepted types.
 *  - "response" (server -> client): the schema describes response bodies.
 *    Breaking: removed required outputs, widened output types.
 *
 * Everything else is reported as "compatible" or "info". Each change carries
 * the schema JSON Pointer of the affected node, a human-readable old/new
 * rule pair and the reason for its severity, so the UI can group changes by
 * pointer and let the user filter breaking items.
 */

const { escapePointer } = require("./infer");

const ALL_TYPES = ["null", "boolean", "integer", "number", "string", "array", "object"];
const PERSPECTIVES = ["request", "response"];

/** @returns {string[] | null} the node's type list, or null when unconstrained */
function typeList(schema) {
  if (!schema || schema.type === undefined) return null;
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

/** Does this schema accept values of JSON type `type`? */
function covers(schema, type) {
  const types = typeList(schema);
  if (types === null) return true; // no `type` keyword: anything goes
  if (types.includes(type)) return true;
  // An integer is always a valid number.
  return type === "integer" && types.includes("number");
}

function describeType(schema) {
  const types = typeList(schema);
  return types === null ? "任意类型" : types.join(" | ");
}

/** Type union comparison: what the new version no longer accepts / newly accepts. */
function compareTypes(oldNode, newNode, pointer, perspective, changes) {
  const lost = ALL_TYPES.filter((t) => covers(oldNode, t) && !covers(newNode, t));
  const gained = ALL_TYPES.filter((t) => !covers(oldNode, t) && covers(newNode, t));
  if (lost.length === 0 && gained.length === 0) return;

  let severity;
  let reason;
  if (perspective === "request") {
    if (lost.length > 0) {
      severity = "breaking";
      reason = `请求体视角：新版不再接受 ${lost.join("、")} 类型，仍发送该类型的旧请求将校验失败（收窄可接受类型）。`;
    } else {
      severity = "compatible";
      reason = `请求体视角：新版额外接受 ${gained.join("、")} 类型，旧请求不受影响（放宽可接受类型）。`;
    }
  } else if (gained.length > 0) {
    severity = "breaking";
    reason = `响应体视角：新版可能输出 ${gained.join("、")} 类型，旧客户端未必能处理（放宽输出类型）。`;
  } else {
    severity = "compatible";
    reason = `响应体视角：新版不再输出 ${lost.join("、")} 类型，输出集合收窄，旧客户端仍可处理。`;
  }

  changes.push({
    pointer,
    kind: "type",
    severity,
    oldRule: `类型：${describeType(oldNode)}`,
    newRule: `类型：${describeType(newNode)}`,
    reason,
  });
}

/** Object comparison: properties added/removed, required flips, recursion. */
function compareObject(oldNode, newNode, pointer, perspective, changes) {
  const oldProps =
    oldNode.properties && typeof oldNode.properties === "object" ? oldNode.properties : {};
  const newProps =
    newNode.properties && typeof newNode.properties === "object" ? newNode.properties : {};
  const oldRequired = new Set(Array.isArray(oldNode.required) ? oldNode.required : []);
  const newRequired = new Set(Array.isArray(newNode.required) ? newNode.required : []);

  // Properties removed from the new schema.
  for (const key of Object.keys(oldProps)) {
    if (Object.prototype.hasOwnProperty.call(newProps, key)) continue;
    const wasRequired = oldRequired.has(key);
    const breaking = perspective === "response" && wasRequired;
    changes.push({
      pointer: `${pointer}/properties/${escapePointer(key)}`,
      kind: "property-removed",
      field: key,
      severity: breaking ? "breaking" : "info",
      oldRule: `类型：${describeType(oldProps[key])}${wasRequired ? "（必填）" : "（可选）"}`,
      newRule: "字段已移除",
      reason: breaking
        ? "响应体视角：新版删除了必填输出字段，依赖该字段的旧客户端将读取失败。"
        : perspective === "response"
          ? "响应体视角：可选输出字段被移除，旧客户端本就需要容忍其缺失。"
          : "请求体视角：服务端不再约束该字段；未声明 additionalProperties:false，携带该字段的旧请求仍可通过。",
    });
  }

  // Properties added in the new schema.
  for (const key of Object.keys(newProps)) {
    if (Object.prototype.hasOwnProperty.call(oldProps, key)) continue;
    const isRequired = newRequired.has(key);
    let severity;
    let reason;
    if (perspective === "request") {
      if (isRequired) {
        severity = "breaking";
        reason = "请求体视角：新版新增必填字段，未携带该字段的旧请求将校验失败。";
      } else {
        severity = "info";
        reason = "请求体视角：新增可选字段，旧请求不受影响。";
      }
    } else {
      severity = "compatible";
      reason = "响应体视角：新增输出字段，旧客户端可忽略未知字段。";
    }
    changes.push({
      pointer: `${pointer}/properties/${escapePointer(key)}`,
      kind: "property-added",
      field: key,
      severity,
      oldRule: "字段不存在",
      newRule: `类型：${describeType(newProps[key])}${isRequired ? "（必填）" : "（可选）"}`,
      reason,
    });
  }

  // Required flips on shared properties, then recurse into them.
  for (const key of Object.keys(oldProps)) {
    if (!Object.prototype.hasOwnProperty.call(newProps, key)) continue;
    const childPointer = `${pointer}/properties/${escapePointer(key)}`;
    const was = oldRequired.has(key);
    const is = newRequired.has(key);
    if (!was && is) {
      changes.push({
        pointer: childPointer,
        kind: "required-added",
        field: key,
        severity: perspective === "request" ? "breaking" : "compatible",
        oldRule: "可选",
        newRule: "必填",
        reason:
          perspective === "request"
            ? "请求体视角：字段由可选变为必填，未携带该字段的旧请求将校验失败。"
            : "响应体视角：字段由可选变为必填，输出更有保障，旧客户端可处理。",
      });
    } else if (was && !is) {
      changes.push({
        pointer: childPointer,
        kind: "required-removed",
        field: key,
        severity: perspective === "response" ? "breaking" : "compatible",
        oldRule: "必填",
        newRule: "可选",
        reason:
          perspective === "response"
            ? "响应体视角：必填输出变为可选，旧客户端依赖的字段可能缺失。"
            : "请求体视角：字段由必填变为可选，旧请求仍然合法。",
      });
    }
    compareNode(oldProps[key], newProps[key], childPointer, perspective, changes);
  }
}

/** Array items comparison: recurse, or report constraint added/removed. */
function compareItems(oldNode, newNode, pointer, perspective, changes) {
  const oldItems = oldNode.items && typeof oldNode.items === "object" ? oldNode.items : null;
  const newItems = newNode.items && typeof newNode.items === "object" ? newNode.items : null;
  const itemsPointer = `${pointer}/items`;

  if (oldItems && newItems) {
    compareNode(oldItems, newItems, itemsPointer, perspective, changes);
    return;
  }
  if (!oldItems && newItems) {
    changes.push({
      pointer: itemsPointer,
      kind: "items-added",
      severity: perspective === "request" ? "breaking" : "compatible",
      oldRule: "items：无约束（任意元素）",
      newRule: `items 类型：${describeType(newItems)}`,
      reason:
        perspective === "request"
          ? "请求体视角：新版新增数组元素约束，收窄了可接受的元素类型，旧请求中的元素可能不再合法。"
          : "响应体视角：新版为数组元素新增约束，输出更有保障，旧客户端可处理。",
    });
  } else if (oldItems && !newItems) {
    changes.push({
      pointer: itemsPointer,
      kind: "items-removed",
      severity: perspective === "response" ? "breaking" : "compatible",
      oldRule: `items 类型：${describeType(oldItems)}`,
      newRule: "items：无约束（任意元素）",
      reason:
        perspective === "response"
          ? "响应体视角：新版移除了数组元素约束，放宽了输出元素类型，旧客户端未必能处理。"
          : "请求体视角：新版移除了数组元素约束，可接受任意元素，旧请求不受影响。",
    });
  }
}

function compareNode(oldNode, newNode, pointer, perspective, changes) {
  const oldObj = oldNode && typeof oldNode === "object" ? oldNode : {};
  const newObj = newNode && typeof newNode === "object" ? newNode : {};
  compareTypes(oldObj, newObj, pointer, perspective, changes);
  compareObject(oldObj, newObj, pointer, perspective, changes);
  compareItems(oldObj, newObj, pointer, perspective, changes);
}

/**
 * Diff two schemas and classify every change.
 *
 * @param {object} oldSchema baseline schema
 * @param {object} newSchema new schema version
 * @param {"request" | "response"} perspective
 * @returns {{ changes: object[], summary: { breaking: number, compatible: number, info: number } }}
 */
function compareSchemas(oldSchema, newSchema, perspective) {
  if (!PERSPECTIVES.includes(perspective)) {
    throw new TypeError(`perspective must be one of: ${PERSPECTIVES.join(", ")}`);
  }
  const changes = [];
  compareNode(oldSchema, newSchema, "", perspective, changes);
  // Sorted by pointer so the UI can group consecutive entries per node.
  changes.sort((a, b) => (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0));
  const summary = { breaking: 0, compatible: 0, info: 0 };
  for (const change of changes) summary[change.severity] += 1;
  return { changes, summary };
}

module.exports = { compareSchemas, PERSPECTIVES, coversType: covers };
