import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeHotspots } from "../api.js";

// Keep in sync with MAX_SAMPLES in server/hotspot.js.
const MAX_SAMPLES = 200;

const TARGET_LABEL = {
  infer: "归纳 Schema",
  variant: "事件变体契约",
};

function clusterKey(cluster) {
  return [
    cluster.schemaPath,
    cluster.keyword,
    cluster.missingProperty ?? "",
    cluster.additionalProperty ?? "",
  ].join("|");
}

export default function HotspotPanel({ schema, target = "infer" }) {
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Bound to the submitted samples text and the active contract (target +
  // schema content); renders only while both still match the current state.
  const [outcome, setOutcome] = useState(null); // { key, ok, data?, message? }
  const [openKey, setOpenKey] = useState(null);

  // Content-based contract signature: re-inferring a changed schema or
  // switching infer/variant invalidates the bound clusters.
  const contractKey = useMemo(
    () => (schema ? `${target} ${JSON.stringify(schema)}` : null),
    [target, schema]
  );
  const bindKey = contractKey === null ? null : `${contractKey} ${text}`;

  // Monotonic request id for staleness checks (see ValidatePanel).
  const seqRef = useRef(0);

  // The samples text, the schema (re-inferred) or the validate target
  // changed: drop the previous clusters/error at once and invalidate any
  // in-flight analysis, whose late success/failure response is ignored.
  useEffect(() => {
    seqRef.current += 1;
    setBusy(false);
    setOutcome(null);
    setOpenKey(null);
  }, [bindKey]);

  const current = outcome && outcome.key === bindKey ? outcome : null;
  const result = current && current.ok ? current.data : null;
  const error = current && !current.ok ? current.message : null;

  async function runAnalysis() {
    setOutcome(null);
    setOpenKey(null);
    let samples;
    try {
      samples = JSON.parse(text);
      setParseError(null);
    } catch (e) {
      setParseError(e.message);
      return;
    }
    if (!Array.isArray(samples)) {
      setOutcome({
        key: bindKey,
        ok: false,
        message: '输入必须是 JSON 数组：每个元素为一条待检样本，例如 [{"id": 1}, {"id": 2}]。',
      });
      return;
    }
    if (samples.length > MAX_SAMPLES) {
      setOutcome({
        key: bindKey,
        ok: false,
        message: `单次最多分析 ${MAX_SAMPLES} 条样本，当前输入共 ${samples.length} 条，请分批分析。`,
      });
      return;
    }
    const seq = (seqRef.current += 1);
    setBusy(true);
    try {
      const data = await analyzeHotspots(schema, samples);
      if (seq !== seqRef.current) return;
      setOutcome({ key: bindKey, ok: true, data });
    } catch (e) {
      if (seq !== seqRef.current) return;
      setOutcome({ key: bindKey, ok: false, message: e.message });
    } finally {
      if (seq === seqRef.current) setBusy(false);
    }
  }

  function toggle(key) {
    setOpenKey((prev) => (prev === key ? null : key));
  }

  return (
    <div className="hotspot-panel">
      <div className="scan-head">
        <span className="panel-label">错误热点</span>
        <span className="panel__meta">
          粘贴待检样本 JSON 数组，按{TARGET_LABEL[target] || "当前 Schema"}
          逐条校验，服务端把 Ajv 错误按规则路径（schemaPath）与关键字聚簇（单次最多 {MAX_SAMPLES}{" "}
          条）
        </span>
      </div>

      <textarea
        className={`code-input ${parseError ? "code-input--err" : ""}`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // The stale parse error belongs to the previous text.
          setParseError(null);
        }}
        spellCheck={false}
        rows={6}
        placeholder='[{"id": 1, "tags": ["admin"]}, {"id": "oops", "tags": [42]}]'
      />
      {parseError && <div className="parse-error">JSON 解析失败：{parseError}</div>}

      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={runAnalysis}
          disabled={busy || text.trim() === ""}
        >
          {busy ? "分析中…" : "分析错误热点"}
        </button>
      </div>
      {error && <div className="alert alert--err">{error}</div>}

      {result && (
        <>
          <div className="hotspot-summary">
            <span className="hotspot-chip">样本 {result.total}</span>
            <span className="hotspot-chip hotspot-chip--ok">通过 {result.validCount}</span>
            <span className="hotspot-chip hotspot-chip--err">失败 {result.invalidCount}</span>
            <span className="hotspot-chip hotspot-chip--err">错误 {result.errorCount}</span>
            <span className="hotspot-chip">热点簇 {result.clusterCount}</span>
            <span className="panel__meta">按受影响样本数降序 · 点击单簇展开样本索引与实例 Pointer</span>
          </div>

          {result.clusterCount === 0 && (
            <div className="alert alert--ok">✓ 全部样本通过校验，没有错误热点。</div>
          )}

          <ul className="hotspot-list">
            {result.clusters.map((cluster, i) => {
              const key = clusterKey(cluster);
              const open = openKey === key;
              return (
                <li key={key} className="hotspot-item">
                  <button
                    type="button"
                    className="hotspot-item__head"
                    onClick={() => toggle(key)}
                    aria-expanded={open}
                  >
                    <span className="hotspot-item__rank">#{i + 1}</span>
                    <span className="flag flag--keyword">{cluster.keyword}</span>
                    <code className="hotspot-item__path">{cluster.schemaPath}</code>
                    {cluster.missingProperty !== undefined && (
                      <code className="hotspot-item__param">
                        缺字段 {cluster.missingProperty}
                      </code>
                    )}
                    {cluster.additionalProperty !== undefined && (
                      <code className="hotspot-item__param">
                        多字段 {cluster.additionalProperty}
                      </code>
                    )}
                    <span className="hotspot-item__stats">
                      {cluster.sampleCount} 份样本 · {cluster.errorCount} 次错误
                    </span>
                    <span className="scan-item__toggle">{open ? "▲" : "▼"}</span>
                  </button>
                  {open && (
                    <div className="hotspot-item__detail">
                      <div className="hotspot-item__samples">
                        受影响样本：
                        {cluster.sampleIndexes.map((idx) => (
                          <code key={idx}>#{idx}</code>
                        ))}
                      </div>
                      <ul className="hotspot-occurrences">
                        {cluster.occurrences.map((occ, j) => (
                          <li key={j}>
                            <code className="hotspot-occurrence__index">#{occ.index}</code>
                            <code className="hotspot-occurrence__pointer">{occ.pointer}</code>
                            <span className="hotspot-occurrence__msg">{occ.message}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
