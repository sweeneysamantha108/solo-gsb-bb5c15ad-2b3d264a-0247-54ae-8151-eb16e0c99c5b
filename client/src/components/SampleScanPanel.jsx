import { useEffect, useMemo, useState } from "react";
import { scanSamples } from "../api.js";
import { SideResult } from "./CounterexamplePanel.jsx";

// Keep in sync with MAX_SAMPLES in server/scan.js.
const MAX_SAMPLES = 200;

// Display order: breakage first, then the rest.
const CATEGORY_ORDER = ["baselineOnly", "currentOnly", "neither", "both"];

const CATEGORY_META = {
  both: { label: "两版均通过", hint: "契约演进对这些样本无影响" },
  baselineOnly: { label: "仅基线通过", hint: "按当前 Schema 将被拒绝，升级前需重点核对" },
  currentOnly: { label: "仅当前通过", hint: "此前不符合基线，当前 Schema 起被接受" },
  neither: { label: "两版均失败", hint: "本就不符合基线契约" },
};

export default function SampleScanPanel({ baselineSchema, currentSchema }) {
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [openIndex, setOpenIndex] = useState(null);

  // Schemas changed (re-inferred or baseline replaced): the previous scan
  // no longer reflects the current comparison, so drop it.
  useEffect(() => {
    setResult(null);
    setError(null);
    setOpenIndex(null);
  }, [baselineSchema, currentSchema]);

  const groups = useMemo(() => {
    if (!result) return [];
    const byCategory = new Map(CATEGORY_ORDER.map((c) => [c, []]));
    for (const item of result.samples) byCategory.get(item.category).push(item);
    return CATEGORY_ORDER.map((c) => [c, byCategory.get(c)]);
  }, [result]);

  async function runScan() {
    setError(null);
    setResult(null);
    setOpenIndex(null);
    let samples;
    try {
      samples = JSON.parse(text);
      setParseError(null);
    } catch (e) {
      setParseError(e.message);
      return;
    }
    if (!Array.isArray(samples)) {
      setError('输入必须是 JSON 数组：每个元素为一条历史样本，例如 [{"id": 1}, {"id": 2}]。');
      return;
    }
    if (samples.length > MAX_SAMPLES) {
      setError(
        `单次最多扫描 ${MAX_SAMPLES} 条样本，当前输入共 ${samples.length} 条，请分批扫描。`
      );
      return;
    }
    setBusy(true);
    try {
      setResult(await scanSamples(baselineSchema, currentSchema, samples));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(index) {
    setOpenIndex((prev) => (prev === index ? null : index));
  }

  return (
    <div className="sample-scan">
      <div className="scan-head">
        <span className="panel-label">样本影响扫描</span>
        <span className="panel__meta">
          粘贴历史样本 JSON 数组，用 Ajv 分别按基线与当前 Schema 逐条校验并归类（单次最多{" "}
          {MAX_SAMPLES} 条）
        </span>
      </div>

      <textarea
        className={`code-input ${parseError ? "code-input--err" : ""}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={6}
        placeholder='[{"id": 1, "phone": null}, {"id": 2, "phone": "+86-13800000000"}]'
      />
      {parseError && <div className="parse-error">JSON 解析失败：{parseError}</div>}

      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={runScan}
          disabled={busy || text.trim() === ""}
        >
          {busy ? "扫描中…" : "开始扫描"}
        </button>
      </div>
      {error && <div className="alert alert--err">{error}</div>}

      {result && (
        <>
          <div className="scan-summary">
            {CATEGORY_ORDER.map((c) => (
              <span key={c} className={`scan-count scan-count--${c}`}>
                {CATEGORY_META[c].label} {result.summary[c]}
              </span>
            ))}
            <span className="panel__meta">共 {result.total} 条 · 点击单条样本展开两侧校验详情</span>
          </div>

          {result.total === 0 && <div className="empty-hint">样本集为空，没有可扫描的内容。</div>}

          {groups.map(([category, items]) =>
            items.length === 0 ? null : (
              <div key={category} className="scan-group">
                <div className="scan-group__head">
                  <span className={`scan-count scan-count--${category}`}>
                    {CATEGORY_META[category].label} {items.length}
                  </span>
                  <span className="panel__meta">{CATEGORY_META[category].hint}</span>
                </div>
                <ul className="scan-list">
                  {items.map((item) => {
                    const open = openIndex === item.index;
                    return (
                      <li key={item.index} className="scan-item">
                        <button
                          type="button"
                          className="scan-item__head"
                          onClick={() => toggle(item.index)}
                          aria-expanded={open}
                        >
                          <span className="scan-item__index">#{item.index}</span>
                          <span
                            className={`ce-badge ${
                              item.baseline.valid ? "ce-badge--ok" : "ce-badge--err"
                            }`}
                          >
                            基线 {item.baseline.valid ? "✓" : "✗"}
                          </span>
                          <span
                            className={`ce-badge ${
                              item.current.valid ? "ce-badge--ok" : "ce-badge--err"
                            }`}
                          >
                            当前 {item.current.valid ? "✓" : "✗"}
                          </span>
                          <span className="scan-item__toggle">{open ? "▲" : "▼"}</span>
                        </button>
                        {open && (
                          <div className="scan-item__detail">
                            <SideResult label="基线 Schema" result={item.baseline} />
                            <SideResult label="当前 Schema" result={item.current} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
