import { useState } from "react";
import { anonymizeSamples } from "../api.js";

// Keep in sync with MAX_SAMPLES in server/anonymize.js.
const MAX_SAMPLES = 200;

const STATUS_LABEL = {
  invalid: "Pointer 非法",
  "non-scalar": "命中对象/数组",
  conflict: "路径冲突",
};

/**
 * Anonymized export, shown inside the sample input panel. The user configures
 * one JSON Pointer pattern per rule (RFC 6901 escaping, single-segment "*"
 * wildcard); the backend recursively matches up to MAX_SAMPLES samples and
 * replaces every hit scalar with a stable, type-preserving pseudonym.
 *
 * The preview (per-rule hit counts, misses and errors) comes back together
 * with the anonymized samples — or, on a refusal (HTTP 422), inside the error
 * body — so both outcomes render the same per-rule list. The copy button is
 * only offered when generation succeeded. The outcome is stored together with
 * a signature of its inputs (rules + sample texts): editing either drops the
 * stale preview, the same convention as the contribution analysis.
 */
export default function AnonymizePanel({ samples, allValid, signature }) {
  const [rules, setRules] = useState([""]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null); // { signature, ok, data, message? }
  const [copied, setCopied] = useState(false);
  const [showJson, setShowJson] = useState(false);

  const trimmedRules = rules.map((rule) => rule.trim());
  const hasBlankRule = trimmedRules.some((rule) => rule === "");
  const runSignature = JSON.stringify([trimmedRules, signature]);

  // Derived invalidation: any rule or sample edit changes the signature, so
  // the old preview stops rendering and an explicit hint appears instead.
  const current = outcome && outcome.signature === runSignature ? outcome : null;
  const invalidated = outcome !== null && outcome.signature !== runSignature;

  const data = current && current.ok ? current.data : null;
  const failure = current && !current.ok ? current : null;
  // A 422 body keeps the per-rule statistics: surface them next to the message.
  const failureRules =
    !data && failure && failure.data && Array.isArray(failure.data.rules)
      ? failure.data.rules
      : null;
  const shownRules = data ? data.rules : failureRules;

  function updateRule(index, value) {
    setRules((prev) => prev.map((rule, i) => (i === index ? value : rule)));
  }

  function addRule() {
    setRules((prev) => [...prev, ""]);
  }

  function removeRule(index) {
    setRules((prev) => prev.filter((_, i) => i !== index));
  }

  async function run() {
    setCopied(false);
    setShowJson(false);
    if (samples.length > MAX_SAMPLES) {
      setOutcome({
        signature: runSignature,
        ok: false,
        message: `单次最多匿名化 ${MAX_SAMPLES} 条样本，当前输入共 ${samples.length} 条，请删减后再预览。`,
      });
      return;
    }
    setBusy(true);
    try {
      const result = await anonymizeSamples(samples, trimmedRules);
      setOutcome({ signature: runSignature, ok: true, data: result });
    } catch (e) {
      setOutcome({ signature: runSignature, ok: false, message: e.message, data: e.data });
    } finally {
      setBusy(false);
    }
  }

  async function copySamples() {
    if (!data) return;
    const text = JSON.stringify(data.samples, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const totalHits = data ? data.rules.reduce((n, rule) => n + rule.hits, 0) : 0;
  const missCount = data ? data.rules.filter((rule) => rule.hits === 0).length : 0;

  return (
    <div className="anonymize">
      <div className="scan-head">
        <span className="panel-label">匿名化导出</span>
        <span className="panel__meta">
          按 JSON Pointer 规则递归匹配样本中的标量并替换为跨样本稳定的假名（类型保留；~ 写作
          ~0、/ 写作 ~1，单段 * 通配对象键或数组下标；单次最多 {MAX_SAMPLES} 条样本）
        </span>
      </div>

      <div className="anonymize-rule-edits">
        {rules.map((rule, i) => (
          <div className="anonymize-rule-edit" key={i}>
            <span className="anonymize-rule-edit__index">规则 {i + 1}</span>
            <input
              className="anonymize-rule-edit__input"
              value={rule}
              onChange={(e) => updateRule(i, e.target.value)}
              placeholder="例如 /email 或 /address/*（* 通配单段键或下标）"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => removeRule(i)}
              disabled={rules.length === 1}
              title={rules.length === 1 ? "至少保留一条规则" : "删除该规则"}
            >
              删除
            </button>
          </div>
        ))}
      </div>

      <div className="actions">
        <button type="button" className="btn" onClick={addRule}>
          + 添加规则
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={run}
          disabled={busy || !allValid || samples.length === 0 || hasBlankRule}
          title={
            !allValid
              ? "请先修正无效的 JSON 样本"
              : hasBlankRule
                ? "存在空白规则，请填写或删除"
                : ""
          }
        >
          {busy ? "匹配中…" : "预览匿名化"}
        </button>
        {data && (
          <>
            <button type="button" className="btn" onClick={() => setShowJson((v) => !v)}>
              {showJson ? "隐藏 JSON" : "查看 JSON"}
            </button>
            <button type="button" className="btn btn--primary" onClick={copySamples}>
              {copied ? "✓ 已复制" : "复制匿名化样本"}
            </button>
          </>
        )}
      </div>

      {invalidated && (
        <div className="alert alert--info">规则或样本已变化，上次预览已失效，请重新预览。</div>
      )}
      {failure && <div className="alert alert--err">{failure.message}</div>}

      {shownRules && (
        <ul className="anonymize-rule-list">
          {shownRules.map((rule) => (
            <li
              key={rule.index}
              className={`anonymize-rule ${rule.status !== "ok" ? "anonymize-rule--err" : ""}`}
            >
              <div className="anonymize-rule__head">
                <span className="anonymize-rule__label">规则 {rule.index + 1}</span>
                <code className="anonymize-rule__pattern">{rule.pattern}</code>
                {rule.status === "ok" && rule.hits > 0 && (
                  <span className="anon-chip anon-chip--ok">命中 {rule.hits} 处</span>
                )}
                {rule.status === "ok" && rule.hits === 0 && (
                  <span className="anon-chip anon-chip--miss">未命中</span>
                )}
                {rule.status !== "ok" && (
                  <span className="anon-chip anon-chip--err">{STATUS_LABEL[rule.status]}</span>
                )}
              </div>
              {rule.error && <div className="anonymize-rule__error">{rule.error}</div>}
              {rule.paths.length > 0 && (
                <ul className="anonymize-paths">
                  {rule.paths.map((pointer) => (
                    <li key={pointer}>
                      <code>{pointer}</code>
                    </li>
                  ))}
                </ul>
              )}
              {rule.pathsTruncated && (
                <div className="panel__meta anonymize-rule__more">
                  …共 {rule.hits} 处，仅展示前 {rule.paths.length} 条
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {data && (
        <div className="panel__meta anonymize-summary">
          {data.totalSamples} 条样本已匿名化，共替换 {totalHits} 处
          {missCount > 0 ? `；${missCount} 条规则未命中，未做任何替换` : ""}。
        </div>
      )}

      {data && showJson && (
        <pre className="schema-raw anonymize-json">{JSON.stringify(data.samples, null, 2)}</pre>
      )}

      {!current && !invalidated && (
        <div className="empty-hint">
          为每条规则填写一个 JSON Pointer 后点击「预览匿名化」：先展示各规则命中数、未命中项与错误，
          确认后即可复制匿名化样本；命中对象/数组，或不同规则命中同一路径时将拒绝生成。
        </div>
      )}
    </div>
  );
}
