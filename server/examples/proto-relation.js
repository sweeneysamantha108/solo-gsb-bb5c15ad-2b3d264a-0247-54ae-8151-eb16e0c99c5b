"use strict";

/**
 * Runnable example: field-relation enhancement when a raw field is literally
 * named "__proto__".
 *
 * Run against a live server (start it with `npm start` from the repo root, or
 * `npm --prefix server run dev`):
 *
 *   node server/examples/proto-relation.js
 *   PORT=8080 node server/examples/proto-relation.js
 *
 * The script exercises the unchanged HTTP contract:
 *   POST /api/relation/mine     -> discover the implication candidates
 *   POST /api/relation/enhance  -> build the enhanced schema (all originals
 *                                  re-validated, 422 otherwise)
 *   POST /api/validate          -> show that a violating NEW sample is rejected
 *
 * Both directions are demonstrated:
 *   "__proto__" -> b  : a document carrying only "__proto__" is rejected
 *   b -> "__proto__"  : a document carrying only "b" is rejected
 *
 * IMPORTANT for any client: a key named "__proto__" must travel as JSON text.
 * Never build such payloads with an object literal (`{ "__proto__": 1 }`) —
 * the literal invokes the prototype setter in non-strict code. Parse a JSON
 * string (the HTTP body parser does this server-side) or use JSON.parse here.
 */

const http = require("node:http");

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "127.0.0.1";
const P = (text) => JSON.parse(text);

function call(path, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
        });
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(buf);
          } catch {
            parsed = buf;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function main() {
  // Two scopes contain both "__proto__" and "b"; a third contains neither.
  // JSON.parse stores "__proto__" as a regular own key, exactly like the
  // server's express.json body parser.
  const samples = [
    P('{"__proto__":1,"b":2}'),
    P('{"__proto__":3,"b":4}'),
    P('{"c":5}'),
  ];

  const inferred = await call("/api/infer", { samples });
  if (inferred.status !== 200) throw new Error(`infer failed: ${JSON.stringify(inferred.body)}`);
  const schema = P(JSON.stringify(inferred.body.schema));

  const mined = await call("/api/relation/mine", { samples, schema });
  if (mined.status !== 200) throw new Error(`mine failed: ${JSON.stringify(mined.body)}`);
  const rules = mined.body.scopes.flatMap((group) => group.implications);
  console.log(
    "mined implications:",
    rules.map((r) => `${JSON.stringify(r.a)} -> ${JSON.stringify(r.b)}`).join(", ")
  );

  for (const rule of rules) {
    const enhanced = await call("/api/relation/enhance", {
      schema,
      samples,
      ruleIds: [rule.id],
    });
    if (enhanced.status !== 200) {
      throw new Error(`enhance failed: ${JSON.stringify(enhanced.body)}`);
    }
    const enhancedSchema = P(JSON.stringify(enhanced.body.schema));
    console.log(`\n--- selected ${JSON.stringify(rule.a)} -> ${JSON.stringify(rule.b)} ---`);
    console.log("injected allOf:", JSON.stringify(enhancedSchema.allOf));

    // The new violating sample: the antecedent present, the consequent absent.
    const violating = rule.a === "__proto__" ? P('{"__proto__":9}') : P('{"b":9}');
    const satisfying = P('{"__proto__":9,"b":8}');
    const neutral = P('{}');

    for (const [label, sample, expected] of [
      ["violating new sample", violating, false],
      ["both keys present", satisfying, true],
      ["neither key present", neutral, true],
      ["every original sample", null, true],
    ]) {
      if (sample === null) {
        let allOk = true;
        for (const original of samples) {
          const r = await call("/api/validate", { schema: enhancedSchema, sample: original });
          if (!r.body.valid) allOk = false;
        }
        console.log(`  ${label}: ${allOk ? "PASS (all re-validated)" : "FAIL"}`);
        if (!allOk) process.exitCode = 1;
        continue;
      }
      const result = await call("/api/validate", { schema: enhancedSchema, sample });
      const ok = result.body.valid === expected;
      console.log(
        `  ${label}: ${result.body.valid ? "accepted" : "rejected"} (expected ${
          expected ? "accepted" : "rejected"
        }) ${ok ? "OK" : "MISMATCH"}`
      );
      if (!ok) process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(
    "Could not reach the server. Start it first:  npm start   (or: npm --prefix server run dev)"
  );
  console.error(err);
  process.exit(1);
});
