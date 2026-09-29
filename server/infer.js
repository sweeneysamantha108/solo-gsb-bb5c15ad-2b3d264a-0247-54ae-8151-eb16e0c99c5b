"use strict";

/**
 * Schema inference engine.
 *
 * Recursively folds N JSON samples into a single JSON Schema (draft 2020-12):
 *  - missing fields   -> property simply absent from `required`
 *  - null values      -> "null" is added to the node's `type` union
 *  - heterogeneous    -> all array elements are folded into one `items` schema
 *    arrays
 *  - type conflicts   -> `type` becomes a sorted union, e.g. ["null", "string"]
 *  - integer + number -> widened to "number"
 *
 * While inferring, a path map is built: schema JSON Pointer -> list of sample
 * JSON Pointers (`#/<sampleIndex>/<path...>`) that provided evidence for the
 * rule. The UI uses it to annotate every tree node with its source samples.
 */

const TYPE_ORDER = ["null", "boolean", "integer", "number", "string", "array", "object"];

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "string":
      return "string";
    default:
      return "object";
  }
}

/** Escape one JSON Pointer segment per RFC 6901. */
function escapePointer(segment) {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Regex source matching the literal JSON key "__proto__" and nothing else.
 * Ajv (v8) deliberately skips a literal `properties.__proto__` entry and the
 * default `required` presence check reads `data.__proto__` (the prototype),
 * so schemas carry the constraint at this `patternProperties` alias as well.
 * The normal `properties`/`required` entry stays the source of truth for the
 * tree view, pointer resolution and every non-Ajv consumer.
 */
const PROTO_KEY = "__proto__";
const PROTO_KEY_PATTERN = "^__proto__$";

/** True when a JSON key needs the Ajv `patternProperties` companion. */
function isProtoKey(key) {
  return key === PROTO_KEY;
}

/**
 * Store `value` under `key` on a plain object as an own data property. This
 * is how JSON.parse treats "__proto__" too: a regular JSON key, not the
 * prototype setter — plain assignment on that name would replace
 * `Object.prototype` for the holder.
 */
function setOwnKey(target, key, value) {
  if (key === PROTO_KEY) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
  return target;
}

/**
 * Keep a schema node's `patternProperties` companion for "__proto__" in sync
 * with its `properties` entry (same subschema reference). Ajv never enforces
 * the literal properties entry, so without this alias the field's type/const
 * would go unchecked; adding the entry lets both describe the same rule.
 */
function syncProtoPattern(node) {
  if (!node || typeof node !== "object" || !node.properties) return;
  const protoSchema = Object.prototype.hasOwnProperty.call(node.properties, PROTO_KEY)
    ? node.properties[PROTO_KEY]
    : undefined;
  if (!node.patternProperties || typeof node.patternProperties !== "object") {
    if (protoSchema === undefined) return;
    node.patternProperties = {};
  }
  if (protoSchema === undefined) {
    delete node.patternProperties[PROTO_KEY_PATTERN];
    if (Object.keys(node.patternProperties).length === 0) delete node.patternProperties;
  } else {
    node.patternProperties[PROTO_KEY_PATTERN] = protoSchema;
  }
}

function sortTypes(typeSet) {
  return [...typeSet].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
}

/**
 * @param {Array<{value: any, path: string}>} observations values seen at this position
 * @param {string} schemaPointer JSON Pointer of this node within the output schema
 * @param {Map<string, string[]>} pathMap accumulator: schema pointer -> sample pointers
 * @returns {object} the inferred schema fragment
 */
function inferNode(observations, schemaPointer, pathMap) {
  const schema = {};
  pathMap.set(schemaPointer, observations.map((o) => o.path));

  const typeSet = new Set(observations.map((o) => typeOf(o.value)));
  // An integer is already a valid number: widen instead of unioning.
  if (typeSet.has("number")) typeSet.delete("integer");
  const types = sortTypes(typeSet);
  schema.type = types.length === 1 ? types[0] : types;

  if (typeSet.has("object")) {
    const objects = observations.filter((o) => typeOf(o.value) === "object");

    // First-seen key order keeps the schema deterministic and readable.
    const keys = [];
    const seen = new Set();
    for (const obs of objects) {
      for (const key of Object.keys(obs.value)) {
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }

    // Keys come straight from JSON samples; setOwnKey stores a literal
    // "__proto__" as a normal own property (like JSON.parse does).
    const properties = {};
    const required = [];
    for (const key of keys) {
      const childObservations = [];
      for (const obs of objects) {
        if (Object.prototype.hasOwnProperty.call(obs.value, key)) {
          childObservations.push({
            value: obs.value[key],
            path: `${obs.path}/${escapePointer(key)}`,
          });
        }
      }
      const childPointer = `${schemaPointer}/properties/${escapePointer(key)}`;
      const childSchema = inferNode(childObservations, childPointer, pathMap);
      setOwnKey(properties, key, childSchema);
      // Present in every object observation -> required; missing anywhere -> optional.
      if (childObservations.length === objects.length) required.push(key);
    }

    schema.properties = properties;
    if (required.length > 0) schema.required = required;
    syncProtoPattern(schema);
  }

  if (typeSet.has("array")) {
    const itemObservations = [];
    for (const obs of observations) {
      if (typeOf(obs.value) !== "array") continue;
      obs.value.forEach((item, index) => {
        itemObservations.push({ value: item, path: `${obs.path}/${index}` });
      });
    }
    // All-empty arrays carry no item evidence: leave `items` unconstrained.
    if (itemObservations.length > 0) {
      schema.items = inferNode(itemObservations, `${schemaPointer}/items`, pathMap);
    }
  }

  return schema;
}

/**
 * Infer a JSON Schema 2020-12 from an array of parsed JSON samples.
 *
 * @param {any[]} samples
 * @returns {{ schema: object, paths: Record<string, string[]> }}
 */
function inferSchema(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("inferSchema expects a non-empty array of samples");
  }
  const observations = samples.map((value, index) => ({ value, path: `#/${index}` }));
  const pathMap = new Map();
  const schema = inferNode(observations, "", pathMap);
  schema.$schema = "https://json-schema.org/draft/2020-12/schema";
  return { schema, paths: Object.fromEntries(pathMap) };
}

module.exports = {
  inferSchema,
  typeOf,
  escapePointer,
  syncProtoPattern,
  setOwnKey,
  isProtoKey,
  PROTO_KEY,
  PROTO_KEY_PATTERN,
};
