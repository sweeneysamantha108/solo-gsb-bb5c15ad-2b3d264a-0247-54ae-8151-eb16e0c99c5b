"use strict";

const path = require("node:path");
const express = require("express");
const Ajv2020 = require("ajv/dist/2020").default;
const { inferSchema } = require("./infer");
const { compareSchemas, PERSPECTIVES } = require("./diff");
const { generateCounterexample } = require("./counterexample");
const { scanSamples } = require("./scan");
const { analyzeContribution } = require("./contribution");
const { buildVariantContract } = require("./variant");
const { anonymizeSamples } = require("./anonymize");
const { buildSlice } = require("./slice");
const { migrateSamples } = require("./migrate");
const { mineRelations, enhanceSchema } = require("./relation");
const { analyzeHotspots } = require("./hotspot");

function createApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // ownProperties: required/property presence must use hasOwnProperty,
  // otherwise a JSON key literally named "__proto__" reads as the prototype.
  const ajv = new Ajv2020({ allErrors: true, verbose: true, strict: false, ownProperties: true });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Infer a 2020-12 schema from an array of samples.
  app.post("/api/infer", (req, res) => {
    const { samples } = req.body || {};
    if (!Array.isArray(samples) || samples.length === 0) {
      return res.status(400).json({ error: "Request body must contain a non-empty 'samples' array." });
    }
    try {
      const { schema, paths } = inferSchema(samples);
      res.json({ schema, paths, sampleCount: samples.length });
    } catch (err) {
      res.status(422).json({ error: `Schema inference failed: ${err.message}` });
    }
  });

  // Validate one sample against a schema; errors carry JSON Pointers.
  app.post("/api/validate", (req, res) => {
    const { schema, sample } = req.body || {};
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return res.status(400).json({ error: "Request body must contain a 'schema' object." });
    }
    let validate;
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      return res.status(422).json({ error: `Invalid schema: ${err.message}` });
    }
    const valid = validate(sample);
    const errors = (validate.errors || []).map((e) => ({
      path: e.instancePath || "",
      pointer: e.instancePath || "(root)",
      schemaPath: e.schemaPath,
      keyword: e.keyword,
      message: e.message,
      params: e.params,
    }));
    res.json({ valid, errors });
  });

  // Error hotspot analysis: validate up to 200 pasted samples against the
  // current schema and cluster the Ajv errors by schemaPath + keyword
  // (required / additionalProperties additionally split by the offending
  // property), so one rule failing at many array indexes forms one cluster.
  app.post("/api/hotspots", (req, res) => {
    const { schema, samples } = req.body || {};
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return res.status(400).json({ error: "Request body must contain a 'schema' object." });
    }
    try {
      res.json(analyzeHotspots({ schema, samples }));
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      res.status(status).json({ error: status === 500 ? "Internal server error" : err.message });
    }
  });

  // Diff two schema versions; changes are classified per request/response perspective.
  app.post("/api/diff", (req, res) => {
    const { oldSchema, newSchema, perspective = "request" } = req.body || {};
    for (const [name, schema] of [["oldSchema", oldSchema], ["newSchema", newSchema]]) {
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return res.status(400).json({ error: `Request body must contain a '${name}' object.` });
      }
    }
    if (!PERSPECTIVES.includes(perspective)) {
      return res
        .status(400)
        .json({ error: `'perspective' must be one of: ${PERSPECTIVES.join(", ")}.` });
    }
    const { changes, summary } = compareSchemas(oldSchema, newSchema, perspective);
    res.json({ perspective, changes, summary });
  });

  // Build a minimal counterexample document for one breaking change, then
  // verify it with Ajv against BOTH schemas before handing it to the UI.
  app.post("/api/counterexample", (req, res) => {
    const { oldSchema, newSchema, perspective = "request", kind, pointer } = req.body || {};
    for (const [name, schema] of [["oldSchema", oldSchema], ["newSchema", newSchema]]) {
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return res.status(400).json({ error: `Request body must contain a '${name}' object.` });
      }
    }
    if (!PERSPECTIVES.includes(perspective)) {
      return res
        .status(400)
        .json({ error: `'perspective' must be one of: ${PERSPECTIVES.join(", ")}.` });
    }
    if (typeof kind !== "string" || kind === "") {
      return res.status(400).json({ error: "Request body must contain a non-empty 'kind' string." });
    }
    if (typeof pointer !== "string") {
      return res.status(400).json({ error: "Request body must contain a 'pointer' string." });
    }
    try {
      const result = generateCounterexample({ oldSchema, newSchema, perspective, kind, pointer });
      res.json(result);
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      res.status(status).json({ error: status === 500 ? "Internal server error" : err.message });
    }
  });

  // Scan a historical sample set against BOTH schema versions and classify
  // each sample (both / baselineOnly / currentOnly / neither).
  app.post("/api/scan", (req, res) => {
    const { oldSchema, newSchema, samples } = req.body || {};
    for (const [name, schema] of [["oldSchema", oldSchema], ["newSchema", newSchema]]) {
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return res.status(400).json({ error: `Request body must contain a '${name}' object.` });
      }
    }
    try {
      res.json(scanSamples({ oldSchema, newSchema, samples }));
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      res.status(status).json({ error: status === 500 ? "Internal server error" : err.message });
    }
  });

  // Leave-one-out contribution analysis: re-infer the schema without each
  // sample and classify it critical/redundant by normalized rule diffs.
  app.post("/api/contribution", (req, res) => {
    const { samples } = req.body || {};
    try {
      res.json(analyzeContribution(samples));
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      res.status(status).json({ error: status === 500 ? "Internal server error" : err.message });
    }
  });

  // Event variant contract: group samples by the value at a discriminator
  // JSON Pointer, infer one branch per group and combine them into `oneOf`.
  // Refusals (illegal pointer, fewer than two groups) still carry the
  // grouping analysis (skipped samples with reasons, group summaries).
  app.post("/api/variant", (req, res) => {
    const { samples, pointer } = req.body || {};
    try {
      res.json(buildVariantContract({ samples, pointer }));
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      res.status(status).json({
        error: status === 500 ? "Internal server error" : err.message,
        ...(err.details || {}),
      });
    }
  });

  // Anonymized export: replace scalars matched by JSON Pointer patterns
  // (single-segment "*" wildcard included) with deterministic, type-
  // preserving pseudonyms. Refusals (illegal pointer, non-scalar hit,
  // cross-rule path conflict) still carry the per-rule statistics.
  app.post("/api/anonymize", (req, res) => {
    const { samples, rules } = req.body || {};
    try {
      res.json(anonymizeSamples({ samples, rules }));
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      res.status(status).json({
        error: status === 500 ? "Internal server error" : err.message,
        ...(err.details || {}),
      });
    }
  });

  // Contract slice: keep only the picked schema nodes (plus the ancestor
  // structure) and project the samples along the same paths. Every
  // projected sample is re-validated against the slice schema with Ajv;
  // a single failure refuses the run and reports the offending sample
  // indexes together with the errors.
  app.post("/api/slice", (req, res) => {
    const { schema, samples, pointers } = req.body || {};
    try {
      res.json(buildSlice({ schema, samples, pointers }));
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      res.status(status).json({
        error: status === 500 ? "Internal server error" : err.message,
        ...(err.details || {}),
      });
    }
  });

  // Historical sample migration: plan the source/target JSON Pointer moves
  // by path depth, apply them atomically per sample (conflicts keep the
  // sample untouched with reasons), then validate every result against the
  // current schema with Ajv and group into success / conflict / invalid.
  app.post("/api/migrate", (req, res) => {
    const { baselineSchema, currentSchema, samples, mappings } = req.body || {};
    try {
      res.json(migrateSamples({ baselineSchema, currentSchema, samples, mappings }));
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      res.status(status).json({
        error: status === 500 ? "Internal server error" : err.message,
        ...(err.details || {}),
      });
    }
  });

  // Field relation mining: collect per-object-scope field presence across
  // all samples and report support>=2 / confidence 100% implication and
  // exclusion candidates (implications transitively reduced).
  app.post("/api/relation/mine", (req, res) => {
    const { samples, schema } = req.body || {};
    try {
      res.json(mineRelations({ samples, schema }));
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      res.status(status).json({ error: status === 500 ? "Internal server error" : err.message });
    }
  });

  // Build the enhanced schema (dependentRequired + not/required) for the
  // picked rules and re-validate every original sample with Ajv; a single
  // failure refuses the run without producing a schema.
  app.post("/api/relation/enhance", (req, res) => {
    const { schema, samples, ruleIds } = req.body || {};
    try {
      res.json(enhanceSchema({ schema, samples, ruleIds }));
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      res.status(status).json({
        error: status === 500 ? "Internal server error" : err.message,
        ...(err.details || {}),
      });
    }
  });

  // Static client (built by Vite into client/dist).
  const clientDist = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "Unknown API endpoint" });
    }
    res.sendFile(path.join(clientDist, "index.html"), (err) => {
      if (err && !res.headersSent) {
        res.status(503).send("Client not built yet. Run `npm run build` inside client/.");
      }
    });
  });

  // JSON body parse errors and anything else: always answer with JSON.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: err.expose ? err.message : "Internal server error" });
  });

  return app;
}

module.exports = { createApp };
