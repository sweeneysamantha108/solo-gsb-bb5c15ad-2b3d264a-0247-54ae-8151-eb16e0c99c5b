export default function SampleEditor({
  index,
  value,
  parseError,
  canRemove,
  highlighted,
  onChange,
  onRemove,
}) {
  return (
    <div
      className={`sample-editor ${highlighted ? "sample-editor--located" : ""}`}
      id={`sample-editor-${index}`}
    >
      <div className="sample-editor__head">
        <span className="sample-editor__title">样本 {index + 1}</span>
        <span className={`parse-badge ${parseError ? "parse-badge--err" : "parse-badge--ok"}`}>
          {parseError ? "JSON 无效" : "JSON 有效"}
        </span>
        {canRemove && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRemove}>
            删除
          </button>
        )}
      </div>
      <textarea
        className={`code-input ${parseError ? "code-input--err" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder="粘贴一份 JSON 样本…"
        rows={10}
      />
      {parseError && <div className="parse-error">{parseError}</div>}
    </div>
  );
}
