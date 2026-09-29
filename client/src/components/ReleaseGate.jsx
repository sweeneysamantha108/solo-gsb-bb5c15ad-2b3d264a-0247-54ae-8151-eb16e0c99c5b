import { useEffect, useMemo, useState } from "react";
import { BUMP_LABELS, REQUIRED_LABELS, buildGateReport, evaluateGate } from "../gate.js";

// Versions survive tab switches and reloads within the browser session,
// matching how the baseline itself is kept.
const STORAGE_KEY = "jcs.releaseGate.versions";

function loadVersions() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    return {
      base: typeof parsed?.base === "string" ? parsed.base : "",
      target: typeof parsed?.target === "string" ? parsed.target : "",
    };
  } catch {
    return { base: "", target: "" };
  }
}

function triggerText(evaluation) {
  if (evaluation.summary.breaking > 0) return `${evaluation.triggerCount} 处破坏性变更`;
  if (evaluation.triggerCount > 0) return `${evaluation.triggerCount} 处兼容/提示级变更`;
  return "无契约变更";
}

export default function ReleaseGate({ diff, perspective }) {
  const [versions, setVersions] = useState(loadVersions);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(versions));
    } catch {
      // sessionStorage unavailable (e.g. privacy mode): keep it in memory only.
    }
  }, [versions]);

  const filled = versions.base.trim() !== "" && versions.target.trim() !== "";

  // Recomputed on every perspective switch (a fresh /api/diff result arrives)
  // and on every version keystroke — no extra request is ever made.
  const evaluation = useMemo(() => {
    if (!diff || diff.perspective !== perspective || !filled) return null;
    return evaluateGate({
      baseVersion: versions.base,
      targetVersion: versions.target,
      perspective,
      summary: diff.summary,
    });
  }, [diff, perspective, versions, filled]);

  async function copyReport() {
    if (!evaluation?.ok) return;
    const text = JSON.stringify(buildGateReport(evaluation), null, 2);
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
    <div className="release-gate">
      <div className="release-gate__head">
        <span className="panel-label">发布门禁</span>
        <span className="panel__meta">
          复用上方{perspective === "request" ? "请求体" : "响应体"}视角差异，填写版本后即时判定
        </span>
      </div>

      <div className="release-gate__inputs">
        <label className="release-gate__field">
          <span>基线版本（当前 SemVer）</span>
          <input
            className="version-input"
            value={versions.base}
            placeholder="如 v1.2.3"
            spellCheck={false}
            onChange={(e) => setVersions((v) => ({ ...v, base: e.target.value }))}
          />
        </label>
        <span className="release-gate__arrow">→</span>
        <label className="release-gate__field">
          <span>目标版本（新版 SemVer）</span>
          <input
            className="version-input"
            value={versions.target}
            placeholder="如 2.0.0-alpha.1"
            spellCheck={false}
            onChange={(e) => setVersions((v) => ({ ...v, target: e.target.value }))}
          />
        </label>
      </div>

      {!filled && (
        <div className="panel__meta">
          填写基线版本与目标版本后，将结合当前差异汇总即时给出放行结论（支持 v 前缀与预发布标识）。
        </div>
      )}

      {evaluation && !evaluation.ok && (
        <div className="alert alert--err">
          {evaluation.errors.map((err) => (
            <div key={err}>{err}</div>
          ))}
        </div>
      )}

      {evaluation && evaluation.ok && (
        <div className={`gate-verdict gate-verdict--${evaluation.allowed ? "allow" : "block"}`}>
          <div className="gate-verdict__head">
            <span className="gate-verdict__badge">
              {evaluation.allowed ? "✓ 允许发布" : "✗ 阻止发布"}
            </span>
            <button type="button" className="btn btn--sm" onClick={copyReport}>
              {copied ? "✓ 已复制" : "复制门禁报告"}
            </button>
          </div>
          <dl className="gate-verdict__facts">
            <div>
              <dt>实际升级类型</dt>
              <dd>{BUMP_LABELS[evaluation.bump]}</dd>
            </div>
            <div>
              <dt>门禁要求</dt>
              <dd>{REQUIRED_LABELS[evaluation.required]}</dd>
            </div>
            <div>
              <dt>触发结论的变更</dt>
              <dd>{triggerText(evaluation)}</dd>
            </div>
          </dl>
          <div className="gate-verdict__reason">{evaluation.reason}</div>
        </div>
      )}
    </div>
  );
}
