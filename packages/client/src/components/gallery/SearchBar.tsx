interface Props {
  value: string;
  onChange: (v: string) => void;
  total: number;
  filtered: number;
}

export default function SearchBar({ value, onChange, total, filtered }: Props) {
  return (
    <div className="search-bar">
      <div className="search-input-wrap">
        <span className="search-icon">🔍</span>
        <input
          type="search"
          className="search-input"
          placeholder="Search photos by name..."
          aria-label="按名称搜索照片"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {value && (
          <button type="button" className="search-clear" onClick={() => onChange("")} aria-label="清空名称搜索">✕</button>
        )}
      </div>
      {value && (
        <span className="search-count">{filtered} / {total}</span>
      )}
    </div>
  );
}
