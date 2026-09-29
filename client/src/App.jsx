import { useEffect, useMemo, useState } from "react";
import SampleEditor from "./components/SampleEditor.jsx";
import SchemaTree from "./components/SchemaTree.jsx";
import ValidatePanel from "./components/ValidatePanel.jsx";
import DiffPanel from "./components/DiffPanel.jsx";
import ContributionPanel from "./components/ContributionPanel.jsx";
import AnonymizePanel from "./components/AnonymizePanel.jsx";
import VariantPanel from "./components/VariantPanel.jsx";
import SlicePanel from "./components/SlicePanel.jsx";
import RelationPanel from "./components/RelationPanel.jsx";
import { inferSchema } from "./api.js";
import { DEFAULT_SAMPLES } from "./defaultSamples.js";

// Baseline lives only in sessionStorage: survives reloads within the tab,
// gone when the browser session ends.
const BASELINE_KEY = "jcs.contractBaseline";

function loadBaseline() {
  try {
    const raw = sessionStorage.getItem(BASELINE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function parseSample(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default function App() {
  const [sampleTexts, setSampleTexts] = useState(DEFAULT_SAMPLES);
  const [result, setResult] = useState(null);
  const [inferError, setInferError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("schema");
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [baseline, setBaseline] = useState(loadBaseline);
  const [locateIndex, setLocateIndex] = useState(null);
  // Last generated variant contract, handed to the validate tab on demand.
  const [variantSchema, setVariantSchema] = useState(null);
  const [validateTarget, setValidateTarget] = useState("infer"); // "infer" | "variant"

  const parsed = useMemo(() => sampleTexts.map(parseSample), [sampleTexts]);
  const allValid = parsed.every((p) => p.ok);
  const validCount = parsed.filter((p) => p.ok).length;
  // Any edit to any sample text changes this signature, which invalidates
  // the previous contribution analysis (see ContributionPanel).
  const samplesSignature = useMemo(() => JSON.stringify(sampleTexts), [sampleTexts]);

  // The "located" highlight on a sample editor fades after a short moment.
  useEffect(() => {
    if (locateIndex === null) return undefined;
    const timer = setTimeout(() => setLocateIndex(null), 1800);
    return () => clearTimeout(timer);
  }, [locateIndex]);

  function locateSample(index) {
    setLocateIndex(index);
    document
      .getElementById(`sample-editor-${index}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function updateSample(index, text) {
    setSampleTexts((prev) => prev.map((t, i) => (i === index ? text : t)));
  }

  function addSample() {
    setSampleTexts((prev) => [...prev, ""]);
  }

  function removeSample(index) {
    setSampleTexts((prev) => prev.filter((_, i) => i !== index));
  }

  async function runInfer() {
    if (!allValid || parsed.length === 0) return;
    setBusy(true);
    setInferError(null);
    try {
      const data = await inferSchema(parsed.map((p) => p.value));
      setResult(data);
      // With a baseline set, the user is evolving the contract: show the diff.
      setTab(baseline ? "diff" : "schema");
    } catch (e) {
      setInferError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function saveBaseline() {
    if (!result) return;
    const entry = {
      schema: result.schema,
      sampleCount: result.sampleCount,
      savedAt: new Date().toISOString(),
    };
    try {
      sessionStorage.setItem(BASELINE_KEY, JSON.stringify(entry));
    } catch {
      // sessionStorage unavailable (e.g. privacy mode): keep it in memory only.
    }
    setBaseline(entry);
    setTab("diff");
  }

  function clearBaseline() {
    try {
      sessionStorage.removeItem(BASELINE_KEY);
    } catch {
      // Ignore: nothing to persist.
    }
    setBaseline(null);
  }

  function useVariantForValidation(schema) {
    setVariantSchema(schema);
    setValidateTarget("variant");
    setTab("validate");
  }

  async function copySchema() {
    if (!result) return;
    const text = JSON.stringify(result.schema, null, 2);
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
    <div className="app">
      <header className="app__header">
        <h1>JSON 契约工坊</h1>
        <p>
          粘贴多份 JSON 样本，递归归纳出 JSON Schema 2020-12 接口契约；自动处理字段缺失、null、
          异构数组与类型冲突，可校验新样本、逐条评估样本贡献度（关键/冗余），并支持把归纳结果设为基线、
          按请求体/响应体视角对比契约演进；还可按判别字段把样本分组，生成带 oneOf 分支的事件变体契约，
          或在 Schema 树勾选节点生成仅保留所选结构的契约切片（同步投影样本）；还可挖掘字段间的
          蕴含/互斥关系（按对象作用域统计、数组元素独立计数），勾选后生成 dependentRequired 与
          not/required 组合的增强 Schema（全部原样本 Ajv 复验通过才产出）。
        </p>
      </header>

      <main className="app__main">
        <section className="panel">
          <div className="panel__head">
            <h2>① 样本输入</h2>
            <span className="panel__meta">
              {validCount}/{sampleTexts.length} 份有效
            </span>
          </div>

          <div className="sample-list">
            {sampleTexts.map((text, i) => (
              <SampleEditor
                key={i}
                index={i}
                value={text}
                parseError={parsed[i].ok ? null : parsed[i].error}
                canRemove={sampleTexts.length > 1}
                highlighted={locateIndex === i}
                onChange={(t) => updateSample(i, t)}
                onRemove={() => removeSample(i)}
              />
            ))}
          </div>

          <div className="actions">
            <button type="button" className="btn" onClick={addSample}>
              + 添加样本
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={runInfer}
              disabled={busy || !allValid || sampleTexts.length === 0}
              title={allValid ? "" : "请先修正无效的 JSON 样本"}
            >
              {busy ? "归纳中…" : "归纳 Schema →"}
            </button>
          </div>
          {inferError && <div className="alert alert--err">{inferError}</div>}

          <ContributionPanel
            samples={parsed.map((p) => (p.ok ? p.value : null))}
            allValid={allValid}
            signature={samplesSignature}
            onLocate={locateSample}
          />

          <AnonymizePanel
            samples={parsed.map((p) => (p.ok ? p.value : null))}
            allValid={allValid}
            signature={samplesSignature}
          />
        </section>

        <section className="panel">
          <div className="panel__head">
            <div className="tabs">
              <button
                type="button"
                className={`tab ${tab === "schema" ? "tab--active" : ""}`}
                onClick={() => setTab("schema")}
              >
                ② 契约 Schema
              </button>
              <button
                type="button"
                className={`tab ${tab === "validate" ? "tab--active" : ""}`}
                onClick={() => setTab("validate")}
              >
                ③ 校验新样本
              </button>
              <button
                type="button"
                className={`tab ${tab === "diff" ? "tab--active" : ""}`}
                onClick={() => setTab("diff")}
              >
                ④ 契约演进
              </button>
              <button
                type="button"
                className={`tab ${tab === "variant" ? "tab--active" : ""}`}
                onClick={() => setTab("variant")}
              >
                ⑤ 事件变体
              </button>
              <button
                type="button"
                className={`tab ${tab === "slice" ? "tab--active" : ""}`}
                onClick={() => setTab("slice")}
              >
                ⑥ 契约切片
              </button>
              <button
                type="button"
                className={`tab ${tab === "relation" ? "tab--active" : ""}`}
                onClick={() => setTab("relation")}
              >
                ⑦ 字段关系
              </button>
            </div>
            {result && tab === "schema" && (
              <div className="panel__tools">
                <button type="button" className="btn btn--sm" onClick={() => setShowRaw(!showRaw)}>
                  {showRaw ? "树形视图" : "原始 JSON"}
                </button>
                <button type="button" className="btn btn--sm" onClick={saveBaseline}>
                  设为基线
                </button>
                <button type="button" className="btn btn--sm btn--primary" onClick={copySchema}>
                  {copied ? "✓ 已复制" : "复制 Schema"}
                </button>
              </div>
            )}
          </div>

          {tab === "schema" &&
            (result ? (
              <>
                <div className="panel__meta panel__meta--block">
                  基于 {result.sampleCount} 份样本归纳 · 点击节点上的「n 处样本」查看规则对应的样本路径
                </div>
                {showRaw ? (
                  <pre className="schema-raw">{JSON.stringify(result.schema, null, 2)}</pre>
                ) : (
                  <SchemaTree schema={result.schema} paths={result.paths} />
                )}
              </>
            ) : (
              <div className="empty-hint">归纳结果将显示在这里：树形视图 + 样本路径标注。</div>
            ))}

          {tab === "validate" && (
            <ValidatePanel
              schema={result?.schema}
              variantSchema={variantSchema}
              target={validateTarget}
              onTargetChange={setValidateTarget}
            />
          )}

          {tab === "variant" && (
            <VariantPanel
              samples={parsed.map((p) => (p.ok ? p.value : null))}
              allValid={allValid}
              signature={samplesSignature}
              onUseForValidation={useVariantForValidation}
            />
          )}

          {tab === "slice" && (
            <SlicePanel
              schema={result?.schema}
              samples={parsed.map((p) => (p.ok ? p.value : null))}
              allValid={allValid}
              signature={samplesSignature}
            />
          )}

          {tab === "relation" && (
            <RelationPanel
              schema={result?.schema}
              samples={parsed.map((p) => (p.ok ? p.value : null))}
              allValid={allValid}
              signature={samplesSignature}
              onUseForValidation={useVariantForValidation}
              onLocate={locateSample}
            />
          )}

          {tab === "diff" && (
            <DiffPanel
              baseline={baseline}
              current={result}
              onSaveBaseline={saveBaseline}
              onClearBaseline={clearBaseline}
            />
          )}
        </section>
      </main>
    </div>
  );
}
