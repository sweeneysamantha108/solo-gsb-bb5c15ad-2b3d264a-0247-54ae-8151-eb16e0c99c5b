import { useState } from "react";
import { generateVariantContract } from "../api.js";
import SchemaTree from "./SchemaTree.jsx";

/**
 * Event variant contract: the user picks a discriminator JSON Pointer, the
 * backend groups samples by the scalar value found there, infers one branch
 * per group (pinning the discriminator with `const`) and combines them into
 * a single `oneOf` schema.
 *
 * The outcome is stored together with a signature of its inputs (sample
 * texts + pointer): editing either invalidates the displayed result, the
 * same convention as the contribution analysis. Refusals (HTTP 422) still
 * carry the grouping analysis — skipped samples with reasons and the groups
 * found — which is rendered so the user can fix the input.
 */
export default function VariantPanel({ samples, allValid, signature, onUseForValidation }) {
  const [pointer, setPointer] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null); // { signature, ok, data, message? }
  const [openGroup, setOpenGroup] = useState(null);
  const [copied, setCopied] = useState(false);

  const trimmedPointer = pointer.trim();
  const runSignature = `${trimmedPointer}\n${signature}`;
  const current = outcome && outcome.signature === runSignature ? outcome : null;
  const invalidated = outcome !== null && outcome.signature !== runSignature;

  const data = current && current.ok ? current.data : null;
  const failure = current && !current.ok ? current : null;
  // A 422 body keeps the analysis: surface it next to the refusal message.
  const failureDetails = failure && failure.data && typeof failure.data === "object"
    ? failure.data
    : null;
  const failedGroups = !data && failureDetails && Array.isArray(failureDetails.groups)
    ? failureDetails.groups
    : null;
  const skipped = data ? data.skipped : failureDetails?.skipped ?? null;

  async function run() {
    setBusy(true);
    try {
      const result = await generateVariantContract(samples, trimmedPointer);
      setOutcome({ signature: runSignature, ok: true, data: result });
      setOpenGroup(0);
      setCopied(false);
    } catch (e) {
      setOutcome({ signature: runSignature, ok: false, message: e.message, data: e.data });
      setOpenGroup(null);
    } finally {
      setBusy(false);
    }
  }

  async function copySchema() {
    if (!data) return;
    const text = JSON.stringify(data.schema, null, 2);
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

  return (
    <div className="variant-panel">
      <div className="scan-head">
        <span className="panel-label">判别字段（JSON Pointer）</span>
        <span className="panel__meta">
          读取每条样本该位置的字符串 / 数字 / 布尔值并按值分组，每组复用归纳引擎生成一个
          oneOf 分支（判别字段固定为对应 const）
        </span>
      </div>

      <input
        className="variant-pointer__input"
        value={pointer}
        onChange={(e) => setPointer(e.target.value)}
        placeholder="例如 /type 或 /meta/event（~ 写作 ~0，/ 写作 ~1）"
        spellCheck={false}
      />

      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={run}
          disabled={busy || !allValid || samples.length === 0 || trimmedPointer === ""}
          title={
            !allValid
              ? "请先修正无效的 JSON 样本"
              : trimmedPointer === ""
                ? "请填写判别字段的 JSON Pointer"
                : ""
          }
        >
          {busy ? "生成中…" : "生成事件变体契约"}
        </button>
        {data && (
          <>
            <button type="button" className="btn" onClick={copySchema}>
              {copied ? "✓ 已复制" : "复制完整 Schema"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => onUseForValidation(data.schema)}
              title="切换到「③ 校验新样本」并以该变体契约为校验目标"
            >
              在校验页验证 →
            </button>
          </>
        )}
      </div>

      {invalidated && (
        <div className="alert alert--info">样本或判别字段已变化，上次生成结果已失效，请重新生成。</div>
      )}

      {failure && (
        <>
          <div className="alert alert--err">{failure.message}</div>
          {failedGroups && failedGroups.length > 0 && (
            <div className="variant-failed-groups">
              <div className="panel__meta">已识别的分组（{failedGroups.length} 个）：</div>
              <ul className="variant-failed-groups__list">
                {failedGroups.map((g, i) => (
                  <li key={i}>
                    <code className="variant-group__value">const {JSON.stringify(g.value)}</code>
                    <span className="variant-group__meta">
                      {g.count} 条样本（{g.sampleIndexes.map((idx) => `样本 ${idx + 1}`).join("、")}）
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {data && (
        <>
          <div className="variant-summary">
            <span className="variant-chip">{data.groupCount} 个分组</span>
            <span className="variant-chip variant-chip--ok">
              有效样本 {data.validSamples}/{data.totalSamples}
            </span>
            {data.skipped.length > 0 && (
              <span className="variant-chip variant-chip--skip">跳过 {data.skipped.length} 条</span>
            )}
            <span className="panel__meta">分支按判别值首次出现排序，点击展开分支 Schema</span>
          </div>

          <div className="variant-groups">
            {data.groups.map((group, gi) => {
              const open = openGroup === gi;
              return (
                <div key={gi} className="variant-group">
                  <button
                    type="button"
                    className="variant-group__head"
                    onClick={() => setOpenGroup(open ? null : gi)}
                    aria-expanded={open}
                  >
                    <span className="variant-group__label">分支 {gi + 1}</span>
                    <code className="variant-group__value">const {JSON.stringify(group.value)}</code>
                    <span className="variant-group__meta">
                      {group.count} 条样本（{group.sampleIndexes.map((idx) => `样本 ${idx + 1}`).join("、")}）
                    </span>
                    <span className="scan-item__toggle">{open ? "▲" : "▼"}</span>
                  </button>
                  {open && (
                    <div className="variant-group__body">
                      <SchemaTree schema={group.schema} paths={group.paths} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {skipped && skipped.length > 0 && (
        <div className="variant-skipped-block">
          <div className="panel__meta">以下样本未参与生成：</div>
          <ul className="variant-skipped">
            {skipped.map((s) => (
              <li key={s.index}>
                <code>样本 {s.index + 1}</code>
                {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!current && !invalidated && (
        <div className="empty-hint">
          填写判别字段的 JSON Pointer 后点击「生成事件变体契约」：每个取值生成一个 oneOf
          分支，分支内判别字段固定为对应 const，仅组内共同存在的字段进入 required；
          判别字段缺失、值为对象 / 数组 / null 的样本不参与生成并在此列出原因。
        </div>
      )}
    </div>
  );
}
