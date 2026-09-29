import { useMemo, useState } from "react";
import { mineFieldRelations, enhanceSchemaWithRelations } from "../api.js";

/**
 * Field relation mining tab.
 *
 * The backend walks every sample and, per object-pointer scope (array
 * elements counted independently, no cross-scope association), reports
 * support>=2 / confidence-100% candidates:
 *
 *   - implication "A -> B" (transitively reduced)  -> dependentRequired
 *   - exclusion   "A / B"                          -> not + required
 *
 * Each rule shows its observation paths and supporting sample indexes; the
 * user ticks rules and generates an enhanced schema, which the backend only
 * returns after every ORIGINAL sample has passed an Ajv re-validation.
 *
 * Like the other panels, the mining result is stored with a signature of the
 * sample texts: editing samples invalidates the result and the selection.
 */
export default function RelationPanel({ schema, samples, allValid, signature, onUseForValidation, onLocate }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [analysis, setAnalysis] = useState(null); // { signature, data }
  const [selected, setSelected] = useState(() => new Set()); // rule ids
  const [openRule, setOpenRule] = useState(null);
  const [openScopes, setOpenScopes] = useState(() => new Set());
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState(null);
  const [enhanced, setEnhanced] = useState(null); // { signature, selectionKey, data }
  const [copied, setCopied] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all"); // all | implication | exclusion

  const result = analysis && analysis.signature === signature ? analysis.data : null;
  const invalidated = analysis !== null && analysis.signature !== signature;
  const hasSchema = schema && typeof schema === "object" && !Array.isArray(schema);

  const allRules = useMemo(() => {
    if (!result) return [];
    return result.scopes.flatMap((group) => [
      ...group.implications,
      ...group.exclusions,
    ]);
  }, [result]);

  const selectableRules = useMemo(
    () => allRules.filter((rule) => !rule.alreadyEnforced),
    [allRules]
  );

  const selectedArray = useMemo(() => allRules.map((r) => r.id).filter((id) => selected.has(id)),
    [allRules, selected]);

  const selectionKey = selectedArray.join("|");
  const enhancedCurrent =
    enhanced &&
    enhanced.signature === signature &&
    enhanced.selectionKey === selectionKey
      ? enhanced.data
      : null;

  function toggleScope(pointer) {
    setOpenScopes((prev) => {
      const next = new Set(prev);
      if (next.has(pointer)) next.delete(pointer);
      else next.add(pointer);
      return next;
    });
  }

  function toggleRule(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setEnhanced(null);
    setEnhanceError(null);
  }

  function selectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const rule of selectableRules) {
        if (typeFilter === "all" || rule.kind === typeFilter) next.add(rule.id);
      }
      return next;
    });
    setEnhanced(null);
    setEnhanceError(null);
  }

  function clearSelection() {
    setSelected(new Set());
    setEnhanced(null);
    setEnhanceError(null);
  }

  async function runMining() {
    setBusy(true);
    setError(null);
    try {
      const data = await mineFieldRelations(samples, hasSchema ? schema : null);
      setAnalysis({ signature, data });
      setSelected(new Set());
      setEnhanced(null);
      setEnhanceError(null);
      // Open every scope that actually has a rule.
      setOpenScopes(
        new Set(
          data.scopes
            .filter(
              (g) =>
                g.implications.some((r) => !r.alreadyEnforced) ||
                g.exclusions.length > 0
            )
            .map((g) => g.scopePointer)
        )
      );
    } catch (e) {
      setAnalysis(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function runEnhance() {
    if (!hasSchema || selectedArray.length === 0) return;
    setEnhancing(true);
    setEnhanceError(null);
    try {
      const data = await enhanceSchemaWithRelations(schema, samples, selectedArray);
      setEnhanced({ signature, selectionKey, data });
      setCopied(false);
    } catch (e) {
      setEnhanced(null);
      setEnhanceError(e);
    } finally {
      setEnhancing(false);
    }
  }

  async function copySchema() {
    if (!enhancedCurrent) return;
    const text = JSON.stringify(enhancedCurrent.schema, null, 2);
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

  function RuleRow({ rule, group }) {
    const id = rule.id;
    const checked = selected.has(id);
    const open = openRule === id;
    const isImplication = rule.kind === "implication";
    const supportSamples = [...new Set(rule.sampleIndexes)].sort((a, b) => a - b);
    return (
      <li className={`rel-rule rel-rule--${rule.kind}`}>
        <div className="rel-rule__head">
          <input
            type="checkbox"
            className="rel-rule__check"
            checked={checked}
            onChange={() => toggleRule(id)}
          />
          <button
            type="button"
            className="rel-rule__main"
            onClick={() => setOpenRule(open ? null : id)}
            aria-expanded={open}
          >
            <span className={`rel-badge rel-badge--${rule.kind}`}>
              {isImplication ? "蕴含" : "互斥"}
            </span>
            <code className="rel-rule__formula">
              {rule.a} {isImplication ? "→" : "⇏"} {rule.b}
            </code>
            <span className="rel-rule__meta">
              支持 {rule.support}
              {isImplication
                ? ` / 作用域 ${rule.scopeCount}`
                : `（${rule.countA} vs ${rule.countB}，共现 0）`}
              {" · 置信度 100%"}
            </span>
            <span className="scan-item__toggle">{open ? "▲" : "▼"}</span>
          </button>
        </div>
        {open && (
          <div className="rel-rule__detail">
            <div className="rel-rule__line">
              <span className="panel__meta">规则形式：</span>
              {isImplication ? (
                <code>{`dependentRequired: { "${rule.a}": ["${rule.b}"] }`}</code>
              ) : (
                <code>{`allOf: [{ not: { required: ["${rule.a}", "${rule.b}"] } }]`}</code>
              )}
            </div>
            <div className="rel-rule__line">
              <span className="panel__meta">作用域 Pointer：</span>
              <code>{group.scopePointer === "" ? "(root)" : group.scopePointer}</code>
            </div>
            <div className="rel-rule__line">
              <span className="panel__meta">
                支持样本（{supportSamples.length} 条，点击可定位）：
              </span>
              <span className="rel-samples">
                {supportSamples.map((i) => (
                  <button
                    key={i}
                    type="button"
                    className="rel-sample-chip"
                    onClick={() => onLocate && onLocate(i)}
                    title="定位到原始样本"
                  >
                    #{i}
                  </button>
                ))}
              </span>
            </div>
            <div className="rel-rule__line">
              <span className="panel__meta">
                {isImplication ? "观测路径" : `含 ${rule.a} 的观测路径`}：
              </span>
            </div>
            <ul className="rel-paths">
              {(isImplication ? rule.witnessPaths : rule.witnessPathsA).map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
            {!isImplication && (
              <>
                <div className="rel-rule__line">
                  <span className="panel__meta">含 {rule.b} 的观测路径：</span>
                </div>
                <ul className="rel-paths">
                  {rule.witnessPathsB.map((p) => (
                    <li key={p}>
                      <code>{p}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {rule.witnessPathsTruncated && (
              <div className="panel__meta">观测路径过多，仅展示前 50 条。</div>
            )}
          </div>
        )}
      </li>
    );
  }

  function ScopeGroup({ group }) {
    const showImplications = typeFilter === "all" || typeFilter === "implication";
    const showExclusions = typeFilter === "all" || typeFilter === "exclusion";
    const implications = showImplications
      ? group.implications.filter((r) => !r.alreadyEnforced)
      : [];
    const enforced = group.implications.filter((r) => r.alreadyEnforced);
    const exclusions = showExclusions ? group.exclusions : [];
    const rules = [...implications, ...exclusions];
    if (rules.length === 0 && enforced.length === 0) return null;
    const open = openScopes.has(group.scopePointer);
    const groupIds = rules.map((r) => r.id);
    const checkedCount = groupIds.filter((id) => selected.has(id)).length;
    return (
      <div className="rel-scope">
        <button
          type="button"
          className="rel-scope__head"
          onClick={() => toggleScope(group.scopePointer)}
          aria-expanded={open}
        >
          <span className="scan-item__toggle">{open ? "▾" : "▸"}</span>
          <code className="rel-scope__pointer">
            {group.scopePointer === "" ? "(root) 根对象" : group.scopePointer}
          </code>
          <span className="rel-scope__meta">
            {group.scopeCount} 个对象作用域 · 候选 {rules.length} 条
            {enforced.length > 0 ? ` · 已被 required 覆盖 ${enforced.length} 条` : ""}
            {checkedCount > 0 ? ` · 已勾选 ${checkedCount} 条` : ""}
          </span>
        </button>
        {open && (
          <div className="rel-scope__body">
            <div className="rel-fields">
              <span className="panel__meta">字段出现集合：</span>
              {group.fields.map((f) => (
                <span key={f.name} className="rel-field-chip">
                  {f.name}
                  <em>×{f.count}</em>
                </span>
              ))}
            </div>
            {rules.length === 0 ? (
              <div className="empty-hint">
                当前筛选下没有候选；该作用域已被 required 覆盖的蕴含无需增强。
              </div>
            ) : (
              <ul className="rel-rules">
                {implications.map((rule) => (
                  <RuleRow key={rule.id} rule={rule} group={group} />
                ))}
                {exclusions.map((rule) => (
                  <RuleRow key={rule.id} rule={rule} group={group} />
                ))}
              </ul>
            )}
            {showImplications && enforced.length > 0 && (
              <details className="rel-enforced">
                <summary>已被 required 覆盖的蕴含（{enforced.length} 条，无需加入）</summary>
                <ul className="rel-rules">
                  {enforced.map((rule) => (
                    <li key={rule.id} className="rel-rule rel-rule--enforced">
                      <span className="rel-badge rel-badge--implication">蕴含</span>
                      <code>
                        {rule.a} → {rule.b}
                      </code>
                      <span className="panel__meta">目标字段本就必填</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relation-panel">
      <div className="scan-head">
        <span className="panel-label">字段关系挖掘</span>
        <span className="panel__meta">
          在每个对象 Pointer 作用域内统计字段出现集合：支持数 ≥ 2、置信度 100% 的「出现 A 必出现
          B」与「A/B 互斥」候选（数组元素按元素独立计数、不跨作用域关联，蕴含已做传递约简）
        </span>
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={runMining}
          disabled={busy || !allValid || samples.length === 0}
          title={allValid ? "" : "请先修正无效的 JSON 样本"}
        >
          {busy ? "挖掘中…" : result ? "重新挖掘字段关系" : "挖掘字段关系"}
        </button>
        {result && (
          <>
            <button
              type="button"
              className="btn"
              onClick={runEnhance}
              disabled={enhancing || !hasSchema || selectedArray.length === 0}
              title={
                !hasSchema
                  ? "请先在「① 样本输入」归纳 Schema"
                  : selectedArray.length === 0
                    ? "请先勾选至少一条规则"
                    : "勾选规则将加入 dependentRequired 与 not/required，后端会用全部原样本经 Ajv 复验"
              }
            >
              {enhancing ? "生成中…" : `生成增强 Schema（${selectedArray.length} 条规则）`}
            </button>
            <button type="button" className="btn" onClick={selectAllVisible}>
              全选当前筛选
            </button>
            <button
              type="button"
              className="btn"
              onClick={clearSelection}
              disabled={selectedArray.length === 0}
            >
              清空勾选
            </button>
            {enhancedCurrent && (
              <>
                <button type="button" className="btn btn--primary" onClick={copySchema}>
                  {copied ? "✓ 已复制" : "复制增强 Schema"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onUseForValidation(enhancedCurrent.schema)}
                  title="切换到「③ 校验新样本」并以该增强 Schema 为校验目标"
                >
                  在校验页验证 →
                </button>
              </>
            )}
          </>
        )}
      </div>

      {error && <div className="alert alert--err">{error}</div>}
      {invalidated && (
        <div className="alert alert--info">样本内容已变化，上次挖掘结果已失效，请重新挖掘。</div>
      )}

      {result && (
        <>
          <div className="variant-summary">
            <span className="variant-chip">{result.scopeCount} 个对象作用域</span>
            <span className="variant-chip variant-chip--ok">
              蕴含候选 {result.summary.implication}
            </span>
            <span className="variant-chip variant-chip--ok">
              互斥候选 {result.summary.exclusion}
            </span>
            {result.summary.removedByTransitiveReduction > 0 && (
              <span className="variant-chip variant-chip--skip">
                传递约简去除 {result.summary.removedByTransitiveReduction} 条冗余蕴含
              </span>
            )}
            <div className="perspective-toggle contribution-filter">
              {[
                ["all", "全部"],
                ["implication", "仅蕴含"],
                ["exclusion", "仅互斥"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={typeFilter === value ? "active" : ""}
                  onClick={() => setTypeFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {selectableRules.length === 0 && (
            <div className="empty-hint">
              当前样本集中没有满足「支持数 ≥ {result.minSupport}
              、置信度 100%」的新增字段关系候选（已被 required 覆盖的蕴含不计入）。
            </div>
          )}

          <div className="rel-scopes">
            {result.scopes.map((group) => (
              <ScopeGroup key={group.scopePointer} group={group} />
            ))}
          </div>
        </>
      )}

      {enhanceError && (
        <div className="alert alert--err">
          {enhanceError.message}
          {Array.isArray(enhanceError.data?.failures) &&
            enhanceError.data.failures.length > 0 && (
              <ul className="slice-problem-list">
                {enhanceError.data.failures.slice(0, 10).map((f) => (
                  <li key={f.index}>
                    <code>样本 {f.index + 1}</code>
                    {f.errors.map((e, i) => (
                      <span key={i}>
                        {" "}
                        {e.keyword}（<code>{e.pointer}</code>）{e.message}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          {Array.isArray(enhanceError.data?.invalidRules) && (
            <ul className="slice-problem-list">
              {enhanceError.data.invalidRules.map((r) => (
                <li key={r.index}>
                  <code>{r.id}</code>
                  {r.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {enhancedCurrent && (
        <div className="variant-summary">
          <span className="variant-chip variant-chip--ok">
            ✓ 全部 {enhancedCurrent.sampleCount} 条原样本已通过 Ajv 复验
          </span>
          <span className="variant-chip">{enhancedCurrent.ruleCount} 条规则已注入</span>
          <span className="panel__meta">
            蕴含 → dependentRequired；互斥 → allOf 内 not/required 组合
          </span>
        </div>
      )}

      {!result && !invalidated && (
        <div className="empty-hint">
          点击「挖掘字段关系」：后端在每个对象 Pointer 作用域内独立统计字段出现（数组元素逐个计数，
          不跨作用域关联），列出支持数 ≥ 2、置信度 100% 的蕴含与互斥候选；展开规则可查看观测路径与
          支持样本，勾选后生成加入 dependentRequired、not/required 组合的增强 Schema，全部原样本经
          Ajv 复验通过后才会产出。
        </div>
      )}
    </div>
  );
}
