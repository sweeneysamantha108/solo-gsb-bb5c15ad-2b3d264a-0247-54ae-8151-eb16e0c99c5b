import { useEffect, useMemo, useRef, useState } from "react";
import { migrateSamples as callMigrate } from "../api.js";
import { SideResult } from "./CounterexamplePanel.jsx";
import { acceptResponse, isRunFresh, migrationSignature } from "../migrationBinding.js";

// Keep in sync with MAX_SAMPLES in server/migrate.js.
const MAX_SAMPLES = 200;

const STATUS_ORDER = ["success", "conflict", "invalid"];

const STATUS_META = {
  success: { label: "迁移成功", cls: "success", hint: "移动/补值完成且通过当前 Schema 的 Ajv 校验" },
  conflict: {
    label: "冲突保持原样",
    cls: "conflict",
    hint: "存在目标冲突或无法写入的路径，整条样本未改动，并逐条说明原因",
  },
  invalid: {
    label: "校验失败",
    cls: "invalid",
    hint: "迁移动作已完成，但结果未通过当前 Schema 校验",
  },
};

/** A single source → target mapping row with an optional default value. */
function MappingRow({ mapping, index, onChange, onRemove, canRemove }) {
  return (
    <div className="migrate-mapping">
      <span className="migrate-mapping__index">{index + 1}</span>
      <input
        className="migrate-mapping__input"
        value={mapping.from}
        onChange={(e) => onChange({ ...mapping, from: e.target.value })}
        spellCheck={false}
        placeholder='源 JSON Pointer（如 /phone，空串 "" 表示根）'
      />
      <span className="migrate-mapping__arrow">→</span>
      <input
        className="migrate-mapping__input"
        value={mapping.to}
        onChange={(e) => onChange({ ...mapping, to: e.target.value })}
        spellCheck={false}
        placeholder="目标 JSON Pointer（如 /contact/phone，末段 - 追加数组）"
      />
      <input
        className="migrate-mapping__default"
        value={mapping.defaultText}
        onChange={(e) => onChange({ ...mapping, defaultText: e.target.value })}
        spellCheck={false}
        placeholder='默认值（可选，JSON，如 null、""、0）'
        title="源路径缺失时写入该默认值；留空表示不补值"
      />
      <button
        type="button"
        className="btn btn--sm btn--ghost migrate-mapping__remove"
        onClick={onRemove}
        disabled={!canRemove}
        title="删除该映射"
      >
        ✕
      </button>
    </div>
  );
}

function OperationTags({ operations }) {
  const label = { move: "移动", default: "补值", skip: "跳过" };
  return (
    <div className="migrate-ops">
      {operations.map((op) => (
        <span key={op.mapping} className={`migrate-op migrate-op--${op.kind}`}>
          <span className="migrate-op__kind">{label[op.kind]}</span>
          <code>{op.from === undefined ? "(默认值)" : op.from || "(root)"}</code>
          <span className="migrate-op__arrow">→</span>
          <code>{op.to}</code>
          {op.kind === "skip" && <span className="migrate-op__reason">{op.reason}</span>}
        </span>
      ))}
    </div>
  );
}

function SampleItem({ item }) {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[item.status];
  return (
    <li className={`migrate-item migrate-item--${meta.cls}`}>
      <button
        type="button"
        className="scan-item__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="scan-item__index">#{item.index}</span>
        <span className={`migrate-badge migrate-badge--${meta.cls}`}>{meta.label}</span>
        <span className="migrate-item__reasons">
          {item.reasons.length > 0 ? item.reasons[0] : ""}
        </span>
        <span className="scan-item__toggle">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="migrate-item__detail">
          {item.reasons.length > 0 && (
            <ul className="migrate-reasons">
              {item.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          )}
          <OperationTags operations={item.operations} />
          <div className="migrate-diff">
            <div className="migrate-diff__side">
              <div className="migrate-diff__label">迁移前（原样本）</div>
              <pre className="ce-sample">{JSON.stringify(item.before, null, 2)}</pre>
            </div>
            <div className="migrate-diff__side">
              <div className="migrate-diff__label">
                迁移后{item.status === "conflict" ? "（冲突，未产出，保持左侧原样）" : ""}
              </div>
              <pre className="ce-sample">
                {item.after === null ? "（保持原样，未生成迁移结果）" : JSON.stringify(item.after, null, 2)}
              </pre>
            </div>
          </div>
          {item.baseline && (
            <SideResult
              label="原样本 · 基线 Schema"
              result={item.baseline}
            />
          )}
          <SideResult
            label={item.status === "conflict" ? "原样本 · 当前 Schema" : "迁移结果 · 当前 Schema"}
            result={item.current}
          />
        </div>
      )}
    </li>
  );
}

/**
 * Historical sample migration, shown on the contract-evolution page. The user
 * pastes up to MAX_SAMPLES old samples and configures source→target JSON
 * Pointer mappings (optional JSON default per mapping). The backend plans
 * the operation order by path depth, applies each sample atomically and
 * validates the results against the current schema; this panel summarizes
 * success/conflict/invalid, expands a before/after comparison per sample and
 * copies ONLY the successful results.
 *
 * Every run is bound to the exact inputs it was submitted with: the sample
 * text, the full mapping set (paths AND default values) and both schema
 * versions. Editing any of those inputs immediately hides the stale summary,
 * details and copy entry and asks for a re-migration. A response returning
 * from an in-flight request is accepted only while the request is still the
 * latest one AND every input still matches what it was sent with; an expired
 * response neither backfills its errors nor overwrites a newer run.
 */
export default function MigrationPanel({ baselineSchema, currentSchema }) {
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState(null);
  const [error, setError] = useState(null);
  const [mappingError, setMappingError] = useState(null);
  const [mappings, setMappings] = useState([
    { from: "/phone", to: "/contact/phone", defaultText: "" },
  ]);
  const [result, setResult] = useState(null);
  const [invalidMappings, setInvalidMappings] = useState([]);
  const [copied, setCopied] = useState(false);
  // True while the latest run's request is still in flight.
  const [busy, setBusy] = useState(false);
  // Input fingerprint the latest run is bound to — set when the user starts
  // the run (covering both its client-side validation errors and the eventual
  // server response), cleared to null on the first edit afterwards. The
  // summary/details/copy entry stay live only while this equals the current
  // input fingerprint.
  const [runSignature, setRunSignature] = useState(null);

  // Fingerprint of every input that can change a migration outcome: the sample
  // text, the full mapping set (paths AND default values) and both schemas.
  const inputSignature = useMemo(
    () => migrationSignature({ text, mappings, baselineSchema, currentSchema }),
    [text, mappings, baselineSchema, currentSchema]
  );

  // Monotonic token: only the request started by the latest run may settle.
  const runSeqRef = useRef(0);
  // Previous render's input signature, updated synchronously in render: an
  // input edit invalidates an in-flight request immediately (bumps the token),
  // before the promise continuation or the reset effect can run.
  const signatureRef = useRef(inputSignature);
  if (signatureRef.current !== inputSignature) {
    signatureRef.current = inputSignature;
    runSeqRef.current += 1;
  }

  // After an input edit, drop the previous run's summary/details/copy entry
  // and stop the spinner. (Display is also gated on the binding below, so the
  // stale run is hidden on the very frame the edit is painted.) The first
  // effect run is the mount, where there is nothing to clear.
  const firstSyncRef = useRef(true);
  useEffect(() => {
    if (firstSyncRef.current) {
      firstSyncRef.current = false;
      return;
    }
    setResult(null);
    setError(null);
    setMappingError(null);
    setInvalidMappings([]);
    setCopied(false);
    setBusy(false);
  }, [inputSignature]);

  // A run is current only while its submitted inputs are still the inputs on
  // screen. Editing the samples, mappings, defaults or either schema breaks
  // the binding until the user migrates again.
  const isFresh = isRunFresh(runSignature, inputSignature);
  const showResult = result !== null && isFresh;
  const showStale = runSignature !== null && !isFresh;

  const groups = useMemo(() => {
    if (!showResult) return [];
    const byStatus = new Map(STATUS_ORDER.map((s) => [s, []]));
    for (const item of result.samples) byStatus.get(item.status).push(item);
    return STATUS_ORDER.map((s) => [s, byStatus.get(s)]);
  }, [showResult, result]);

  const successfulSamples = useMemo(
    () =>
      showResult
        ? result.samples.filter((s) => s.status === "success").map((s) => s.after)
        : [],
    [showResult, result]
  );

  function updateMapping(index, next) {
    setMappings((prev) => prev.map((mapping, i) => (i === index ? next : mapping)));
  }

  function addMapping() {
    setMappings((prev) => [...prev, { from: "", to: "", defaultText: "" }]);
  }

  function removeMapping(index) {
    setMappings((prev) => prev.filter((_, i) => i !== index));
  }

  /** Build the request mappings, parsing the optional default JSON. */
  function buildMappings() {
    return mappings.map((mapping) => {
      const entry = { from: mapping.from.trim(), to: mapping.to.trim() };
      if (mapping.defaultText.trim() !== "") {
        entry.default = JSON.parse(mapping.defaultText);
      }
      return entry;
    });
  }

  async function run() {
    // This run supersedes any request still in flight. The attempt (including
    // its client-side validation errors) is bound to the inputs right now;
    // editing them afterwards hides this run until the user migrates again.
    const seq = ++runSeqRef.current;
    const submittedSignature = inputSignature;
    setRunSignature(submittedSignature);
    setBusy(false);
    setError(null);
    setMappingError(null);
    setInvalidMappings([]);
    setResult(null);
    let samples;
    try {
      samples = JSON.parse(text);
      setParseError(null);
    } catch (e) {
      setParseError(e.message);
      return;
    }
    if (!Array.isArray(samples)) {
      setError('输入必须是 JSON 数组：每个元素为一条旧样本，例如 [{"phone": "123"}, {"phone": null}]。');
      return;
    }
    if (samples.length === 0) {
      setError("样本数组不能为空。");
      return;
    }
    if (samples.length > MAX_SAMPLES) {
      setError(`单次最多迁移 ${MAX_SAMPLES} 条样本，当前共 ${samples.length} 条，请分批迁移。`);
      return;
    }
    let requestMappings;
    try {
      requestMappings = buildMappings();
    } catch (e) {
      setMappingError(`默认值必须是合法 JSON（如 null、""、0、{"x":1}）：${e.message}`);
      return;
    }
    if (
      requestMappings.length === 0 ||
      requestMappings.some((m) => m.from === "" && m.to === "")
    ) {
      // A blank source and blank target together is an unconfigured row;
      // source "" alone is valid (it addresses the sample root).
      setMappingError("请至少配置一条映射，且源与目标不能同时留空。");
      return;
    }
    if (requestMappings.some((m) => m.to === "")) {
      setMappingError('目标 JSON Pointer 不能为样本根（""），请指定具体字段。');
      return;
    }
    setBusy(true);
    try {
      const data = await callMigrate(baselineSchema, currentSchema, samples, requestMappings);
      // Accept only if this is still the latest run and none of its inputs
      // (sample text, mappings, defaults, either schema) changed meanwhile;
      // an expired response must not backfill errors or overwrite a new run.
      if (!acceptResponse(seq, runSeqRef.current, submittedSignature, inputSignature)) return;
      setResult(data);
    } catch (e) {
      if (!acceptResponse(seq, runSeqRef.current, submittedSignature, inputSignature)) return;
      setError(e.message);
      if (e.data && Array.isArray(e.data.invalidMappings)) {
        setInvalidMappings(e.data.invalidMappings);
      }
    } finally {
      if (seq === runSeqRef.current) setBusy(false);
    }
  }

  async function copySuccessful() {
    if (successfulSamples.length === 0) return;
    const textToCopy = JSON.stringify(successfulSamples, null, 2);
    try {
      await navigator.clipboard.writeText(textToCopy);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = textToCopy;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="migrate">
      <div className="scan-head">
        <span className="panel-label">历史样本迁移</span>
        <span className="panel__meta">
          粘贴最多 {MAX_SAMPLES} 条旧样本，按「源 JSON Pointer → 目标 JSON Pointer」配置移动规则（可带
          JSON 默认值）；后端先按路径深度规划操作，再对每条样本原子执行，冲突样本保持原样并说明原因，
          最后用 Ajv 按当前 Schema 校验
        </span>
      </div>

      <textarea
        className={`code-input ${parseError ? "code-input--err" : ""}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={5}
        placeholder='[{"id": 1, "phone": "+86-138"}, {"id": 2, "phone": null}]'
      />
      {parseError && <div className="parse-error">JSON 解析失败：{parseError}</div>}

      <div className="migrate-mappings">
        {mappings.map((mapping, i) => (
          <MappingRow
            key={i}
            mapping={mapping}
            index={i}
            canRemove={mappings.length > 1}
            onChange={(next) => updateMapping(i, next)}
            onRemove={() => removeMapping(i)}
          />
        ))}
        <div className="actions">
          <button type="button" className="btn btn--sm" onClick={addMapping}>
            + 添加映射
          </button>
        </div>
      </div>
      {mappingError && isFresh && <div className="alert alert--err">{mappingError}</div>}
      {invalidMappings.length > 0 && isFresh && (
        <ul className="slice-problem-list">
          {invalidMappings.map((problem) => (
            <li key={problem.index}>
              <code>
                第 {problem.index + 1} 条（{problem.from || "(root)"} → {problem.to || "(root)"}）
              </code>
              {problem.reason}
            </li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={run}
          disabled={busy || text.trim() === ""}
        >
          {busy ? "迁移中…" : showResult || isFresh ? "重新迁移" : "开始迁移"}
        </button>
        {showResult && successfulSamples.length > 0 && (
          <button type="button" className="btn" onClick={copySuccessful}>
            {copied ? "✓ 已复制" : `仅复制成功结果（${successfulSamples.length} 条）`}
          </button>
        )}
      </div>
      {showStale && !busy && (
        <div className="alert alert--info">
          自上次提交迁移后输入已变更（旧样本文本、映射路径/默认值或基线/当前 Schema），上一次迁移的
          汇总、明细与「仅复制成功结果」均已失效并隐藏，避免导出与当前配置不符的样本；
          请点击「开始迁移」重新迁移。
        </div>
      )}
      {error && isFresh && <div className="alert alert--err">{error}</div>}

      {showResult && (
        <>
          <div className="scan-summary">
            {STATUS_ORDER.map((status) => (
              <span key={status} className={`migrate-badge migrate-badge--${STATUS_META[status].cls}`}>
                {STATUS_META[status].label} {result.summary[status]}
              </span>
            ))}
            <span className="panel__meta">
              结果绑定提交时的旧样本、映射配置与两版 Schema · 共 {result.total} 条 ·
              点击单条展开前后对比
            </span>
          </div>

          {groups.map(([status, items]) =>
            items.length === 0 ? null : (
              <div key={status} className="scan-group">
                <div className="scan-group__head">
                  <span className={`migrate-badge migrate-badge--${STATUS_META[status].cls}`}>
                    {STATUS_META[status].label} {items.length}
                  </span>
                  <span className="panel__meta">{STATUS_META[status].hint}</span>
                </div>
                <ul className="scan-list">
                  {items.map((item) => (
                    <SampleItem key={item.index} item={item} />
                  ))}
                </ul>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
