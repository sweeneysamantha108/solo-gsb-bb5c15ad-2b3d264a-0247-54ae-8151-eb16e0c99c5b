import { useState } from "react";
import { sliceContract } from "../api.js";
import SchemaTree from "./SchemaTree.jsx";

// Keep in sync with MAX_POINTERS in server/slice.js.
const MAX_POINTERS = 20;

/** Display form of a schema pointer; the root ("") reads "(root)". */
function pointerLabel(pointer) {
  return pointer === "" ? "(root)" : pointer;
}

/**
 * Contract slice: the user ticks 1..MAX_POINTERS nodes of the current schema
 * tree; the backend keeps only those nodes (plus the ancestor structure) in
 * a standalone slice schema and projects every sample along the same paths,
 * re-validating each projection with Ajv — a single failure refuses the run
 * and reports the offending sample indexes.
 *
 * The outcome is stored together with a signature of its inputs (selection +
 * sample texts): editing either invalidates the displayed result, the same
 * convention as the contribution analysis and the variant contract.
 */
export default function SlicePanel({ schema, samples, allValid, signature }) {
  const [selected, setSelected] = useState([]); // canonical schema pointers
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null); // { signature, ok, data, message? }
  const [copiedSchema, setCopiedSchema] = useState(false);
  const [copiedSamples, setCopiedSamples] = useState(false);
  const [showSchema, setShowSchema] = useState(false);
  const [showSamples, setShowSamples] = useState(false);

  const hasSchema = schema && typeof schema === "object" && !Array.isArray(schema);
  const selectedSet = new Set(selected);
  const limitReached = selected.length >= MAX_POINTERS;

  const runSignature = `${JSON.stringify([...selected].sort())}\n${signature}`;
  // Derived invalidation: any selection or sample edit changes the signature,
  // so the old result stops rendering and an explicit hint appears instead.
  const current = outcome && outcome.signature === runSignature ? outcome : null;
  const invalidated = outcome !== null && outcome.signature !== runSignature;

  const data = current && current.ok ? current.data : null;
  const failure = current && !current.ok ? current : null;
  // A 422 body keeps the analysis: surface it next to the refusal message.
  const failureDetails = failure && failure.data && typeof failure.data === "object"
    ? failure.data
    : null;
  const failures = !data && failureDetails && Array.isArray(failureDetails.failures)
    ? failureDetails.failures
    : null;
  const invalidPointers = !data && failureDetails && Array.isArray(failureDetails.invalidPointers)
    ? failureDetails.invalidPointers
    : null;

  function isDescendant(ancestor, pointer) {
    return pointer.startsWith(ancestor === "" ? "/" : `${ancestor}/`);
  }

  function toggle(pointer) {
    setSelected((prev) => {
      if (prev.includes(pointer)) return prev.filter((p) => p !== pointer);
      if (prev.length >= MAX_POINTERS) return prev;
      // Ancestor wins: picking a node covers everything below it.
      return [...prev.filter((p) => !isDescendant(pointer, p)), pointer];
    });
  }

  function removePointer(pointer) {
    setSelected((prev) => prev.filter((p) => p !== pointer));
  }

  async function run() {
    setBusy(true);
    setCopiedSchema(false);
    setCopiedSamples(false);
    setShowSchema(false);
    setShowSamples(false);
    try {
      const result = await sliceContract(schema, samples, selected);
      setOutcome({ signature: runSignature, ok: true, data: result });
    } catch (e) {
      setOutcome({ signature: runSignature, ok: false, message: e.message, data: e.data });
    } finally {
      setBusy(false);
    }
  }

  async function copyText(text, markCopied) {
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
    markCopied(true);
    setTimeout(() => markCopied(false), 1500);
  }

  if (!hasSchema) {
    return (
      <div className="empty-hint">
        请先在「① 样本输入」点击「归纳 Schema →」，再在此勾选需要保留的节点生成契约切片。
      </div>
    );
  }

  return (
    <div className="slice-panel">
      <div className="scan-head">
        <span className="panel-label">勾选保留节点（1～{MAX_POINTERS} 个）</span>
        <span className="panel__meta">
          生成仅保留所选节点及必要祖先结构的独立 Schema，并同步投影当前样本；祖先已选时其子项自动包含
        </span>
      </div>

      <div className="slice-selected">
        <span className={`variant-chip ${selected.length > 0 ? "variant-chip--ok" : ""}`}>
          已选 {selected.length}/{MAX_POINTERS}
        </span>
        {selected.map((pointer) => (
          <span key={pointer} className="slice-chip">
            <code>{pointerLabel(pointer)}</code>
            <button
              type="button"
              className="slice-chip__remove"
              onClick={() => removePointer(pointer)}
              title="移除该选择"
            >
              ✕
            </button>
          </span>
        ))}
        {selected.length === 0 && (
          <span className="panel__meta">在下方 Schema 树勾选节点；勾选祖先会自动包含其子树</span>
        )}
      </div>

      <div className="slice-tree">
        <SchemaTree
          schema={schema}
          paths={{}}
          selectable
          selectedSet={selectedSet}
          onToggle={toggle}
          limitReached={limitReached}
        />
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={run}
          disabled={busy || !allValid || selected.length === 0}
          title={
            !allValid
              ? "请先修正无效的 JSON 样本"
              : selected.length === 0
                ? "请先在 Schema 树勾选至少一个节点"
                : ""
          }
        >
          {busy ? "生成中…" : "生成契约切片"}
        </button>
        {data && (
          <>
            <button type="button" className="btn" onClick={() => setShowSchema((v) => !v)}>
              {showSchema ? "隐藏 Schema" : "查看 Schema"}
            </button>
            <button type="button" className="btn" onClick={() => setShowSamples((v) => !v)}>
              {showSamples ? "隐藏样本" : "查看样本"}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => copyText(JSON.stringify(data.schema, null, 2), setCopiedSchema)}
            >
              {copiedSchema ? "✓ 已复制" : "复制切片 Schema"}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => copyText(JSON.stringify(data.samples, null, 2), setCopiedSamples)}
            >
              {copiedSamples ? "✓ 已复制" : "复制投影样本"}
            </button>
          </>
        )}
      </div>

      {invalidated && (
        <div className="alert alert--info">选择或样本已变化，上次切片结果已失效，请重新生成。</div>
      )}

      {failure && (
        <>
          <div className="alert alert--err">{failure.message}</div>
          {invalidPointers && (
            <ul className="slice-problem-list">
              {invalidPointers.map((p) => (
                <li key={p.index}>
                  <code>第 {p.index + 1} 个 Pointer（{pointerLabel(p.pointer)}）</code>
                  {p.reason}
                </li>
              ))}
            </ul>
          )}
          {failures && (
            <div className="slice-failures">
              {failures.map((f) => (
                <div key={f.index} className="slice-failure">
                  <div className="slice-failure__head">
                    <code className="scan-item__index">样本 {f.index + 1}</code>
                    <span className="ce-badge ce-badge--err">校验失败</span>
                  </div>
                  <ul className="ce-errors">
                    {f.errors.map((e, i) => (
                      <li key={i} className="ce-error">
                        <div className="ce-error__head">
                          <code className="ce-error__pointer">{e.pointer}</code>
                          <span className="ce-badge ce-badge--err">{e.keyword}</span>
                        </div>
                        <div className="ce-error__msg">{e.message}</div>
                        <div className="ce-error__meta">
                          规则路径 <code>{e.schemaPath}</code>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {data && (
        <>
          <div className="variant-summary">
            <span className="variant-chip variant-chip--ok">字段数 {data.fieldCount}</span>
            <span className="variant-chip variant-chip--ok">样本数 {data.sampleCount}</span>
            <span className="variant-chip">生效 Pointer {data.pointers.length} 个</span>
            {data.ignored.length > 0 && (
              <span className="variant-chip variant-chip--skip">
                忽略 {data.ignored.length} 个
              </span>
            )}
            <span className="panel__meta">投影样本均已通过切片 Schema 的 Ajv 校验</span>
          </div>

          {data.ignored.length > 0 && (
            <ul className="slice-problem-list">
              {data.ignored.map((item, i) => (
                <li key={i}>
                  <code>{pointerLabel(item.pointer)}</code>
                  {item.reason}
                </li>
              ))}
            </ul>
          )}

          {showSchema && (
            <pre className="schema-raw slice-json">{JSON.stringify(data.schema, null, 2)}</pre>
          )}
          {showSamples && (
            <pre className="schema-raw slice-json">{JSON.stringify(data.samples, null, 2)}</pre>
          )}
        </>
      )}

      {!current && !invalidated && (
        <div className="empty-hint">
          在 Schema 树勾选 1～{MAX_POINTERS} 个节点后点击「生成契约切片」：对象只保留命中的
          properties，required 仅保留原本必填且仍存在的字段，数组沿 items 递归，类型联合与 const
          不变；后端会用 Ajv 逐条校验投影样本，任一失败则不产出并在此列出样本序号与错误。
        </div>
      )}
    </div>
  );
}
