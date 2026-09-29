import { useState } from "react";
import { generateCounterexample } from "../api.js";

const SIDE_LABELS = {
  request: { old: "旧版 Schema（请求曾被接受）", new: "新版 Schema（请求被拒绝）" },
  response: { old: "旧版 Schema（响应被拒绝）", new: "新版 Schema（响应可以输出）" },
};

export function SideResult({ label, result }) {
  if (!result) return null;
  return (
    <div className={`ce-side ${result.valid ? "ce-side--ok" : "ce-side--err"}`}>
      <div className="ce-side__head">
        <span className={`ce-badge ${result.valid ? "ce-badge--ok" : "ce-badge--err"}`}>
          {result.valid ? "✓ 通过" : "✗ 拒绝"}
        </span>
        <span className="ce-side__label">{label}</span>
      </div>
      {!result.valid && result.errors.length > 0 && (
        <ul className="ce-errors">
          {result.errors.map((e, i) => (
            <li key={i} className="ce-error">
              <div className="ce-error__head">
                <code className="ce-error__pointer">{e.pointer}</code>
                <span className="flag flag--keyword">{e.keyword}</span>
              </div>
              <div className="ce-error__msg">{e.message}</div>
              <div className="ce-error__meta">
                规则：<code>{e.schemaPath}</code>
                {e.params && Object.keys(e.params).length > 0 && (
                  <>
                    {" "}
                    · 参数：<code>{JSON.stringify(e.params)}</code>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function CounterexamplePanel({ oldSchema, newSchema, perspective, change }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    setData(null);
    try {
      const result = await generateCounterexample(
        oldSchema,
        newSchema,
        perspective,
        change.kind,
        change.pointer
      );
      setData(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data && !busy) run();
  }

  async function copySample() {
    if (!data?.constructible) return;
    const text = JSON.stringify(data.sample, null, 2);
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
    <div className="counterexample">
      <button
        type="button"
        className="btn btn--sm ce-toggle"
        onClick={toggle}
        aria-expanded={open}
      >
        {open ? "收起反例" : "生成反例"}
      </button>

      {open && (
        <div className="ce-body">
          {busy && <div className="panel__meta">正在递归构造最小样本并用 Ajv 双侧校验…</div>}
          {error && <div className="alert alert--err">{error}</div>}

          {data && !data.constructible && (
            <div className="alert alert--err">
              <div className="ce-reason-title">无法构造反例</div>
              <div className="ce-reason">{data.reason}</div>
            </div>
          )}

          {data?.constructible && (
            <>
              <div className="ce-section">
                <div className="ce-section__head">
                  <span className="panel-label">最小反例样本</span>
                  <button type="button" className="btn btn--sm" onClick={copySample}>
                    {copied ? "✓ 已复制" : "复制样本"}
                  </button>
                </div>
                <pre className="ce-sample">{JSON.stringify(data.sample, null, 2)}</pre>
              </div>
              <div className="ce-section">
                <div className="panel-label">双侧 Ajv 校验结果</div>
                <SideResult
                  label={SIDE_LABELS[perspective].old}
                  result={data.oldResult}
                />
                <SideResult
                  label={SIDE_LABELS[perspective].new}
                  result={data.newResult}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
