import { useEffect, useMemo, useState } from "react";
import { diffSchemas } from "../api.js";
import ReleaseGate from "./ReleaseGate.jsx";
import CounterexamplePanel from "./CounterexamplePanel.jsx";
import SampleScanPanel from "./SampleScanPanel.jsx";
import MigrationPanel from "./MigrationPanel.jsx";

const KIND_LABELS = {
  type: "类型联合变化",
  "required-added": "新增必填",
  "required-removed": "取消必填",
  "property-added": "新增字段",
  "property-removed": "移除字段",
  "items-added": "新增元素约束",
  "items-removed": "移除元素约束",
};

const SEVERITY_LABELS = {
  breaking: "破坏性",
  compatible: "兼容",
  info: "提示",
};

const PERSPECTIVE_HINTS = {
  request: "请求体视角（客户端 → 服务端）：新版新增必填、收窄可接受类型判为破坏性。",
  response: "响应体视角（服务端 → 客户端）：新版删除必填输出、放宽输出类型判为破坏性。",
};

export default function DiffPanel({ baseline, current, onSaveBaseline, onClearBaseline }) {
  const [perspective, setPerspective] = useState("request");
  const [breakingOnly, setBreakingOnly] = useState(false);
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const currentSchema = current?.schema ?? null;

  useEffect(() => {
    if (!baseline || !currentSchema) {
      setDiff(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    diffSchemas(baseline.schema, currentSchema, perspective)
      .then((data) => {
        if (!cancelled) setDiff(data);
      })
      .catch((e) => {
        if (!cancelled) {
          setDiff(null);
          setError(e.message);
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [baseline, currentSchema, perspective]);

  // Group the (already pointer-sorted) changes by their schema JSON Pointer.
  const groups = useMemo(() => {
    if (!diff) return [];
    const visible = breakingOnly
      ? diff.changes.filter((c) => c.severity === "breaking")
      : diff.changes;
    const byPointer = new Map();
    for (const change of visible) {
      const list = byPointer.get(change.pointer) || [];
      list.push(change);
      byPointer.set(change.pointer, list);
    }
    return [...byPointer.entries()];
  }, [diff, breakingOnly]);

  if (!baseline) {
    return (
      <div className="diff-panel">
        <div className="empty-hint">
          暂无基线。先归纳出一份 Schema 并设为基线，再修改样本归纳新版，即可在此对比契约演进。
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={onSaveBaseline}
            disabled={!current}
          >
            将当前归纳结果设为基线
          </button>
        </div>
        {!current && <div className="panel__meta">请先在左侧点击「归纳 Schema」。</div>}
      </div>
    );
  }

  return (
    <div className="diff-panel">
      <div className="diff-toolbar">
        <span className="baseline-meta">
          基线：{baseline.sampleCount} 份样本 · 保存于{" "}
          {new Date(baseline.savedAt).toLocaleTimeString()}（仅当前浏览器会话）
        </span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={onSaveBaseline}
          disabled={!current}
        >
          将当前结果设为基线
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onClearBaseline}>
          清除基线
        </button>
      </div>

      {!current && <div className="empty-hint">修改左侧样本并重新「归纳 Schema」，即可与基线对比。</div>}

      {current && (
        <>
          <div className="diff-toolbar">
            <div className="perspective-toggle">
              <button
                type="button"
                className={perspective === "request" ? "active" : ""}
                onClick={() => setPerspective("request")}
              >
                请求体视角
              </button>
              <button
                type="button"
                className={perspective === "response" ? "active" : ""}
                onClick={() => setPerspective("response")}
              >
                响应体视角
              </button>
            </div>
            <label className="diff-checkbox">
              <input
                type="checkbox"
                checked={breakingOnly}
                onChange={(e) => setBreakingOnly(e.target.checked)}
              />
              仅显示破坏性变更
            </label>
          </div>
          <div className="panel__meta panel__meta--block">{PERSPECTIVE_HINTS[perspective]}</div>

          {busy && <div className="panel__meta">对比中…</div>}
          {error && <div className="alert alert--err">{error}</div>}

          {diff && !busy && (
            <>
              <div className="diff-summary">
                <span className="severity severity--breaking">{diff.summary.breaking} 破坏性</span>
                <span className="severity severity--compatible">
                  {diff.summary.compatible} 兼容
                </span>
                <span className="severity severity--info">{diff.summary.info} 提示</span>
              </div>

              <ReleaseGate diff={diff} perspective={perspective} />

              {diff.changes.length === 0 && (
                <div className="alert alert--ok">✓ 两版 Schema 完全一致，无契约变更。</div>
              )}
              {diff.changes.length > 0 && diff.summary.breaking === 0 && (
                <div className="alert alert--ok">✓ 无破坏性变更，可安全演进。</div>
              )}
              {diff.summary.breaking > 0 && (
                <div className="alert alert--err">
                  ✗ 发现 {diff.summary.breaking} 处破坏性变更，发布前请确认调用方已适配。
                </div>
              )}
              {groups.length === 0 && diff.changes.length > 0 && (
                <div className="empty-hint">
                  当前筛选条件下无变更，取消「仅显示破坏性变更」查看全部。
                </div>
              )}

              <div className="diff-groups">
                {groups.map(([pointer, changes]) => (
                  <div key={pointer} className="diff-group">
                    <div className="diff-group__pointer">
                      <code>{pointer || "(root)"}</code>
                    </div>
                    <ul className="change-list">
                      {changes.map((c, i) => (
                        <li key={i} className={`change-item change-item--${c.severity}`}>
                          <div className="change-item__head">
                            <span className={`severity severity--${c.severity}`}>
                              {SEVERITY_LABELS[c.severity]}
                            </span>
                            <span className="change-kind">
                              {KIND_LABELS[c.kind] || c.kind}
                              {c.field ? `：${c.field}` : ""}
                            </span>
                          </div>
                          <div className="change-item__rules">
                            <code className="rule-old">{c.oldRule}</code>
                            <span className="rule-arrow">→</span>
                            <code className="rule-new">{c.newRule}</code>
                          </div>
                          <div className="change-item__reason">{c.reason}</div>
                          {c.severity === "breaking" && (
                            <CounterexamplePanel
                              oldSchema={baseline.schema}
                              newSchema={currentSchema}
                              perspective={perspective}
                              change={c}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </>
          )}

          <SampleScanPanel baselineSchema={baseline.schema} currentSchema={currentSchema} />
          <MigrationPanel baselineSchema={baseline.schema} currentSchema={currentSchema} />
        </>
      )}
    </div>
  );
}
