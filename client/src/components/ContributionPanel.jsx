import { useMemo, useState } from "react";
import { analyzeContribution } from "../api.js";

// Keep in sync with MAX_SAMPLES in server/contribution.js.
const MAX_SAMPLES = 50;

const VERDICT_META = {
  critical: { label: "关键", hint: "移除后契约规则会发生变化" },
  redundant: { label: "冗余", hint: "移除后归纳出的契约完全一致" },
};

const FILTERS = [
  ["all", "全部"],
  ["critical", "仅关键"],
  ["redundant", "仅冗余"],
];

/**
 * Leave-one-out sample contribution analysis, shown inside the sample input
 * panel. The result is stored together with the signature of the analyzed
 * sample texts: as soon as the user edits any sample, the signature no longer
 * matches and the stale result is dropped (with an explicit hint).
 */
export default function ContributionPanel({ samples, allValid, signature, onLocate }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [analysis, setAnalysis] = useState(null); // { signature, data }
  const [filter, setFilter] = useState("all");
  const [openIndex, setOpenIndex] = useState(null);

  // Derived invalidation: any sample edit changes the signature, so the old
  // result stops rendering and an explicit "invalidated" hint appears instead.
  const result = analysis && analysis.signature === signature ? analysis.data : null;
  const invalidated = analysis !== null && analysis.signature !== signature;

  const visible = useMemo(() => {
    if (!result) return [];
    if (filter === "all") return result.samples;
    return result.samples.filter((s) => s.verdict === filter);
  }, [result, filter]);

  async function runAnalysis() {
    setError(null);
    if (samples.length > MAX_SAMPLES) {
      setAnalysis(null);
      setError(
        `单次最多分析 ${MAX_SAMPLES} 条样本，当前输入共 ${samples.length} 条，请删减后再分析。`
      );
      return;
    }
    setBusy(true);
    try {
      const data = await analyzeContribution(samples);
      setAnalysis({ signature, data });
      setFilter("all");
      setOpenIndex(null);
    } catch (e) {
      setAnalysis(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(index) {
    setOpenIndex((prev) => (prev === index ? null : index));
  }

  return (
    <div className="contribution">
      <div className="scan-head">
        <span className="panel-label">样本贡献度分析</span>
        <span className="panel__meta">
          逐条移除样本并重新归纳 Schema：规则发生变化即为「关键」，完全一致即为「冗余」（单次最多{" "}
          {MAX_SAMPLES} 条）
        </span>
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={runAnalysis}
          disabled={busy || !allValid || samples.length === 0}
          title={allValid ? "" : "请先修正无效的 JSON 样本"}
        >
          {busy ? "分析中…" : "分析样本贡献度"}
        </button>
      </div>
      {error && <div className="alert alert--err">{error}</div>}
      {invalidated && (
        <div className="alert alert--info">样本内容已变化，上次分析结果已失效，请重新分析。</div>
      )}

      {result && (
        <>
          <div className="contribution-summary">
            <span className="verdict verdict--critical">关键 {result.summary.critical}</span>
            <span className="verdict verdict--redundant">冗余 {result.summary.redundant}</span>
            <span className="panel__meta">共 {result.total} 条</span>
            <div className="perspective-toggle contribution-filter">
              {FILTERS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 && (
            <div className="empty-hint">当前筛选条件下没有样本，切换筛选查看全部。</div>
          )}

          <ul className="contribution-list">
            {visible.map((item) => {
              const open = openIndex === item.index;
              const meta = VERDICT_META[item.verdict];
              return (
                <li
                  key={item.index}
                  className={`contribution-item contribution-item--${item.verdict}`}
                >
                  <div className="contribution-item__head">
                    <button
                      type="button"
                      className="contribution-item__main"
                      onClick={() => toggle(item.index)}
                      aria-expanded={open}
                    >
                      <span className="scan-item__index">样本 {item.index + 1}</span>
                      <span className={`verdict verdict--${item.verdict}`}>{meta.label}</span>
                      <span className="contribution-item__meta">
                        {item.verdict === "critical"
                          ? `影响 ${item.affectedPointers.length} 条规则`
                          : meta.hint}
                      </span>
                      <span className="scan-item__toggle">{open ? "▲" : "▼"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => onLocate(item.index)}
                    >
                      定位样本
                    </button>
                  </div>
                  {open && (
                    <div className="contribution-item__detail">
                      {item.affectedPointers.length === 0 ? (
                        <div className="panel__meta">
                          移除该样本后，归纳出的 Schema 与完整样本集完全一致。
                        </div>
                      ) : (
                        <>
                          <div className="panel__meta">移除该样本后受影响的规则（JSON Pointer）：</div>
                          <ul className="contribution-pointers">
                            {item.affectedPointers.map((pointer) => (
                              <li key={pointer}>
                                <code>{pointer || "(root)"}</code>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
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
