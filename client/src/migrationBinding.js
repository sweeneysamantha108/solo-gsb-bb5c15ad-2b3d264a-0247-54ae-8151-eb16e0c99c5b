/**
 * Input binding for the historical sample migration.
 *
 * A migration run is only valid for the exact inputs it was submitted with:
 * the pasted sample text, the complete mapping set (source pointers, target
 * pointers AND default-value texts) plus both schema versions. Whenever any
 * of those changes, the previous run's summary, per-sample details and the
 * "copy successful results" entry must be hidden until the user migrates
 * again, and a response from the request that was in flight must be rejected.
 *
 * Pure module (no React/browser dependency) so the binding rules are unit
 * testable; MigrationPanel keeps the React state around them.
 */

/**
 * Stable fingerprint of every input that can change a migration result.
 * Fingerprints are compared with strict equality, so the JSON form must be
 * deterministic for equivalent inputs (schema objects are serialized the same
 * way the panel hands them to the API).
 *
 * @param {{ text: string,
 *           mappings: Array<{ from: string, to: string, defaultText: string }>,
 *           baselineSchema: object|null|undefined,
 *           currentSchema: object|null|undefined }} inputs
 * @returns {string}
 */
export function migrationSignature({ text, mappings, baselineSchema, currentSchema }) {
  return JSON.stringify({
    text,
    mappings: (mappings || []).map((m) => ({
      from: m.from,
      to: m.to,
      defaultText: m.defaultText,
    })),
    baseline: baselineSchema ?? null,
    current: currentSchema ?? null,
  });
}

/**
 * Whether a run bound to `submittedSignature` is still current for the inputs
 * producing `currentSignature`.
 */
export function isRunFresh(submittedSignature, currentSignature) {
  return submittedSignature !== null && submittedSignature === currentSignature;
}

/**
 * Whether a response settling after an awaited request may be accepted.
 *
 * @param {number} responseSeq sequence token the settling request started with
 * @param {number} latestSeq   sequence token of the most recently started run
 * @param {string} submittedSignature fingerprint captured when the request
 *                                    was dispatched
 * @param {string} currentSignature   fingerprint of the inputs rendered now
 * @returns {boolean} false for an expired run or an input edit mid-flight
 */
export function acceptResponse(responseSeq, latestSeq, submittedSignature, currentSignature) {
  return responseSeq === latestSeq && submittedSignature === currentSignature;
}
