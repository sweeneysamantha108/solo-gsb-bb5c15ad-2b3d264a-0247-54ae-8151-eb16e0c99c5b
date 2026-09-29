async function request(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`服务响应异常（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（HTTP ${res.status}）`);
    // Keep the structured body (e.g. variant grouping details on 422).
    err.data = data;
    throw err;
  }
  return data;
}

export function inferSchema(samples) {
  return request("/api/infer", { samples });
}

export function validateSample(schema, sample) {
  return request("/api/validate", { schema, sample });
}

export function analyzeHotspots(schema, samples) {
  return request("/api/hotspots", { schema, samples });
}

export function diffSchemas(oldSchema, newSchema, perspective) {
  return request("/api/diff", { oldSchema, newSchema, perspective });
}

export function generateCounterexample(oldSchema, newSchema, perspective, kind, pointer) {
  return request("/api/counterexample", { oldSchema, newSchema, perspective, kind, pointer });
}

export function scanSamples(oldSchema, newSchema, samples) {
  return request("/api/scan", { oldSchema, newSchema, samples });
}

export function analyzeContribution(samples) {
  return request("/api/contribution", { samples });
}

export function generateVariantContract(samples, pointer) {
  return request("/api/variant", { samples, pointer });
}

export function anonymizeSamples(samples, rules) {
  return request("/api/anonymize", { samples, rules });
}

export function sliceContract(schema, samples, pointers) {
  return request("/api/slice", { schema, samples, pointers });
}

export function migrateSamples(baselineSchema, currentSchema, samples, mappings) {
  return request("/api/migrate", { baselineSchema, currentSchema, samples, mappings });
}

export function mineFieldRelations(samples, schema) {
  return request("/api/relation/mine", { samples, schema });
}

export function enhanceSchemaWithRelations(schema, samples, ruleIds) {
  return request("/api/relation/enhance", { schema, samples, ruleIds });
}
