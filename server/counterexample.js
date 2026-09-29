"use strict";

/**
 * Breaking-change counterexample generator.
 *
 * Given the old and new schemas, the evolution perspective and the JSON
 * Pointer of one (breaking) change reported by `diff.js`, it recursively
 * builds a *minimal* JSON document that proves the breakage:
 *
 *  - request perspective  -> valid against the OLD schema, rejected by NEW.
 *  - response perspective -> valid against the NEW schema, rejected by OLD.
 *
 * Required sibling fields along the document path get the smallest
 * placeholders satisfying the accepting side (preferring values also
 * accepted by the rejecting side). The resulting document is checked with
 * Ajv against BOTH schemas; it is returned only when the required direction
 * actually holds, otherwise the caller receives a human-readable reason.
 *
 * The construction target is described by:
 *   steps  – instance-path steps (object keys / array indices) to traverse
 *   action – how the reached node witnesses the break:
 *       "set"     -> replace the reached node with a discriminating value
 *       "element" -> reached node is an array; give it one discriminating
 *                    element
 *       "omit"    -> reached node is an object; omit `omitKey` (keeping the
 *                    accepting side's other required siblings)
 */

const Ajv2020 = require("ajv/dist/2020").default;
const { coversType } = require("./diff");
const { setOwnKey } = require("./infer");

const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });

// All JSON types; scalars first and most-specific first, so an `integer`
// slot picks 0 even when `number` is also acceptable.
const ALL_TYPE_ORDER = ["null", "boolean", "integer", "number", "string", "array", "object"];

/** Raised when no counterexample satisfying the required direction exists. */
class NotConstructible extends Error {}

function isObjectSchema(node) {
  return !!node && typeof node === "object" && !Array.isArray(node);
}

function typeList(schema) {
  if (!isObjectSchema(schema) || schema.type === undefined) return null;
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function scalarValue(type) {
  switch (type) {
    case "null":
      return null;
    case "boolean":
      return false;
    case "integer":
      return 0;
    case "number":
      return 0.5; // non-integer: cannot be mistaken for an `integer` slot
    case "string":
      return "";
    default:
      throw new NotConstructible(`类型 ${type} 没有可用的标量占位值。`);
  }
}

/** Placeholder of one concrete type at the accepting node. */
function genTyped(acceptNode, type) {
  if (type === "object") return genSatisfyingObject(acceptNode, {});
  if (type === "array") return [];
  return scalarValue(type);
}

/**
 * Smallest value valid under the accepting node, preferring one also valid
 * under the rejecting node. A `false` schema forbids everything.
 */
function genValue(acceptNode, rejectNode) {
  if (acceptNode === false) {
    throw new NotConstructible("所在节点被 schema 禁止（false），无法生成占位值。");
  }
  const freeAccept = !isObjectSchema(acceptNode) || typeList(acceptNode) === null;
  const freeReject = !isObjectSchema(rejectNode) || typeList(rejectNode) === null;
  const acceptedByAccept = (t) => freeAccept || coversType(acceptNode, t);
  const acceptedByReject = (t) => freeReject || coversType(rejectNode, t);

  // Pass 1: satisfy both sides; pass 2: accepting side only.
  for (const requireReject of [true, false]) {
    for (const type of ALL_TYPE_ORDER) {
      if (!acceptedByAccept(type)) continue;
      if (requireReject && !acceptedByReject(type)) continue;
      try {
        if (type === "object") return genSatisfyingObject(acceptNode, rejectNode);
        if (type === "array") return [];
        return scalarValue(type);
      } catch {
        // Try the next candidate type.
      }
    }
  }
  throw new NotConstructible("无法为必填兄弟字段生成满足接受侧约束的占位值。");
}

/**
 * Smallest object valid under the accepting node: its required keys are
 * present (children prefer values also valid under the rejecting node).
 * `omitKey` is skipped to witness a requiredness break.
 */
function genSatisfyingObject(acceptNode, rejectNode, omitKey = null) {
  const obj = {};
  const propsAccept = isObjectSchema(acceptNode) && acceptNode.properties ? acceptNode.properties : {};
  const propsReject = isObjectSchema(rejectNode) && rejectNode.properties ? rejectNode.properties : {};
  const required =
    isObjectSchema(acceptNode) && Array.isArray(acceptNode.required) ? acceptNode.required : [];
  for (const key of required) {
    if (key === omitKey) continue;
    if (!Object.prototype.hasOwnProperty.call(propsAccept, key)) continue;
    const childReject = Object.prototype.hasOwnProperty.call(propsReject, key)
      ? propsReject[key]
      : {};
    try {
      setOwnKey(obj, key, genValue(propsAccept[key], childReject));
    } catch {
      // Drop the key; the final Ajv verification judges whether that is legal.
    }
  }
  return obj;
}

/**
 * Object at a path node on the way to the witness. It must satisfy BOTH
 * sides so Ajv attributes the failure solely to the witnessed change:
 * required keys from both sides are merged (accept-valid placeholders),
 * except `nextKey`, whose value is supplied by the caller.
 */
function genPathObject(acceptNode, rejectNode, nextKey, nextValue) {
  const obj = {};
  const propsAccept = isObjectSchema(acceptNode) && acceptNode.properties ? acceptNode.properties : {};
  const propsReject = isObjectSchema(rejectNode) && rejectNode.properties ? rejectNode.properties : {};
  const reqAccept = new Set(
    isObjectSchema(acceptNode) && Array.isArray(acceptNode.required) ? acceptNode.required : []
  );
  const reqReject = new Set(
    isObjectSchema(rejectNode) && Array.isArray(rejectNode.required) ? rejectNode.required : []
  );
  for (const key of new Set([...reqAccept, ...reqReject])) {
    if (key === nextKey) continue;
    const hasAccept = Object.prototype.hasOwnProperty.call(propsAccept, key);
    const hasReject = Object.prototype.hasOwnProperty.call(propsReject, key);
    try {
      if (hasAccept && hasReject) {
        setOwnKey(obj, key, genValue(propsAccept[key], propsReject[key]));
      } else if (hasAccept) {
        setOwnKey(obj, key, genValue(propsAccept[key], propsAccept[key]));
      } else if (hasReject) {
        // Only the rejecting side requires/knows it: the accept side does
        // not constrain this key, so a reject-valid placeholder suffices.
        setOwnKey(obj, key, genValue(propsReject[key], propsReject[key]));
      }
    } catch {
      // Drop the key; the final Ajv verification catches an illegal drop.
    }
  }
  setOwnKey(obj, nextKey, nextValue);
  return obj;
}

/** Parse a JSON Pointer into unescaped segments ("" root -> []). */
function parsePointer(pointer) {
  if (pointer === "") return [];
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw Object.assign(new Error("JSON Pointer 必须为空或以 / 开头。"), { status: 400 });
  }
  return pointer
    .substring(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Walk schema segments; an absent node resolves to null. */
function resolveNode(root, segments) {
  let node = root;
  for (const seg of segments) {
    if (seg === "properties") continue;
    if (!isObjectSchema(node)) return null;
    node = seg === "items" ? node.items || null : node.properties ? node.properties[seg] : null;
  }
  return node ?? null;
}

/**
 * Schema segments -> instance-path steps. `/properties/<key>` collapses to
 * one object-key step; each `/items` becomes an array-index slot (0).
 */
function toInstanceSteps(segments) {
  const steps = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === "properties") {
      steps.push({ type: "key", key: segments[i + 1] });
      i++;
    } else if (segments[i] === "items") {
      steps.push({ type: "index", index: 0 });
    }
  }
  return steps;
}

/** Concrete types allowed by `accept` but not by `reject` (preference order). */
function discriminatingTypes(accept, reject) {
  const freeAccept = !isObjectSchema(accept) || typeList(accept) === null;
  if (!isObjectSchema(reject) || typeList(reject) === null) return []; // rejects nothing
  return ALL_TYPE_ORDER.filter(
    (t) => (freeAccept || coversType(accept, t)) && !coversType(reject, t)
  );
}

/**
 * Recursively construct the document up to (and including) the witness.
 *
 * At every object along the path, both sides' required siblings are filled;
 * the action at the reached node differs per change kind.
 */
function buildDocument(acceptNode, rejectNode, steps, target) {
  if (steps.length === 0) {
    if (target.action === "set") return target.value;
    if (target.action === "element") return [target.value];
    return genSatisfyingObject(acceptNode, rejectNode, target.omitKey); // "omit"
  }
  const [step, ...rest] = steps;
  if (step.type === "index") {
    return [
      buildDocument(
        isObjectSchema(acceptNode) ? acceptNode.items || null : null,
        isObjectSchema(rejectNode) ? rejectNode.items || null : null,
        rest,
        target
      ),
    ];
  }
  const { key } = step;
  const childAccept =
    isObjectSchema(acceptNode) && acceptNode.properties ? acceptNode.properties[key] || null : null;
  const childReject =
    isObjectSchema(rejectNode) && rejectNode.properties ? rejectNode.properties[key] || null : null;
  const childValue = buildDocument(childAccept, childReject, rest, target);
  return genPathObject(acceptNode, rejectNode, key, childValue);
}

/** Describe the construction target for one change. */
function planTarget({ oldSchema, newSchema, request, kind, segments }) {
  const node = (root, segs) => resolveNode(root, segs);
  const acceptNode = (segs) => (request ? node(oldSchema, segs) : node(newSchema, segs));
  const rejectNode = (segs) => (request ? node(newSchema, segs) : node(oldSchema, segs));

  if (kind === "type") {
    const types = discriminatingTypes(acceptNode(segments), rejectNode(segments));
    if (types.length === 0) {
      throw new NotConstructible(
        "两版 Schema 在该节点接受完全相同的实例类型，差异无法仅用取值类型触发（可能被其他约束抵消），无法构造反例。"
      );
    }
    // Property type change: witness is the property value, steps stop at
    // the containing object. Root / items type changes replace the node.
    const isProperty =
      segments.length >= 2 && segments[segments.length - 2] === "properties";
    if (isProperty) {
      const key = segments[segments.length - 1];
      const parentSegs = segments.slice(0, -2);
      return {
        steps: [...toInstanceSteps(parentSegs), { type: "key", key }],
        target: { action: "set", value: genTyped(acceptNode(segments) || {}, types[0]) },
      };
    }
    return {
      steps: toInstanceSteps(segments),
      target: { action: "set", value: genTyped(acceptNode(segments) || {}, types[0]) },
    };
  }

  if (kind === "items-added" || kind === "items-removed") {
    if (segments[segments.length - 1] !== "items") {
      throw Object.assign(new Error(`变更 ${kind} 的 Pointer 应以 /items 结尾。`), { status: 400 });
    }
    const types = discriminatingTypes(acceptNode(segments), rejectNode(segments));
    if (types.length === 0) {
      throw new NotConstructible(
        "两版 Schema 的数组元素接受完全相同的实例类型，差异无法仅用取值类型触发（可能被其他约束抵消），无法构造反例。"
      );
    }
    const arraySegs = segments.slice(0, -1);
    // Walk to the ARRAY (instance steps include every enclosing items),
    // then give it exactly one discriminating element.
    return {
      steps: toInstanceSteps(arraySegs),
      target: { action: "element", value: genTyped(acceptNode(segments) || {}, types[0]) },
    };
  }

  if (
    kind === "required-added" ||
    kind === "required-removed" ||
    kind === "property-added" ||
    kind === "property-removed"
  ) {
    if (segments.length < 2 || segments[segments.length - 2] !== "properties") {
      throw Object.assign(
        new Error(`变更 ${kind} 的 Pointer 应指向某个属性（/properties/<字段名>）。`),
        { status: 400 }
      );
    }
    const omitKey = segments[segments.length - 1];
    const parentSegs = segments.slice(0, -2);
    return {
      steps: toInstanceSteps(parentSegs),
      target: { action: "omit", omitKey },
    };
  }

  throw Object.assign(new Error(`暂不支持为变更类型 ${kind} 生成反例。`), { status: 400 });
}

/**
 * Build a counterexample for one change.
 *
 * @returns {{ sample: any }} document believed to satisfy the direction
 */
function construct({ oldSchema, newSchema, perspective, kind, pointer }) {
  const request = perspective === "request";
  const segments = parsePointer(pointer);
  const { steps, target } = planTarget({ oldSchema, newSchema, request, kind, segments });
  const sample = buildDocument(
    request ? oldSchema : newSchema,
    request ? newSchema : oldSchema,
    steps,
    target
  );
  return { sample };
}

function mapErrors(validate) {
  return (validate.errors || []).map((e) => ({
    path: e.instancePath || "",
    pointer: e.instancePath || "(root)",
    schemaPath: e.schemaPath,
    keyword: e.keyword,
    message: e.message,
    params: e.params,
  }));
}

/**
 * Construct a counterexample and verify it with Ajv against both schemas.
 *
 * Direction:
 *  - request  -> oldValid === true  && newValid === false
 *  - response -> newValid === true  && oldValid === false
 *
 * @returns {{ constructible: boolean, reason?: string, sample?: any,
 *            perspective?: string, kind?: string, pointer?: string,
 *            oldResult?: object, newResult?: object }}
 */
function generateCounterexample({ oldSchema, newSchema, perspective, kind, pointer }) {
  let validateOld;
  let validateNew;
  try {
    validateOld = ajv.compile(oldSchema);
    validateNew = ajv.compile(newSchema);
  } catch (err) {
    throw Object.assign(new Error(`Invalid schema: ${err.message}`), { status: 422 });
  }

  let sample;
  try {
    ({ sample } = construct({ oldSchema, newSchema, perspective, kind, pointer }));
  } catch (err) {
    if (err instanceof NotConstructible) return { constructible: false, reason: err.message };
    throw err;
  }

  const oldValid = validateOld(sample);
  const newValid = validateNew(sample);
  const oldResult = { valid: oldValid, errors: oldValid ? [] : mapErrors(validateOld) };
  const newResult = { valid: newValid, errors: newValid ? [] : mapErrors(validateNew) };

  const acceptPassed = perspective === "request" ? oldValid : newValid;
  const rejectPassed = perspective === "request" ? newValid : oldValid;
  if (acceptPassed && !rejectPassed) {
    return { constructible: true, perspective, kind, pointer, sample, oldResult, newResult };
  }

  const acceptLabel = perspective === "request" ? "旧版" : "新版";
  const rejectLabel = perspective === "request" ? "新版" : "旧版";
  const reason = !acceptPassed
    ? `构造出的样本未能通过${acceptLabel} Schema 校验，变更可能被同节点的其他约束（如 enum、minLength、required 兄弟字段）抵消，无法构造最小反例。`
    : `构造出的样本同时通过了两版 Schema（${rejectLabel} 也接受它），该变更在实例层面无法被单独触发，无法构造反例。`;
  return { constructible: false, reason };
}

module.exports = { generateCounterexample, NotConstructible };
