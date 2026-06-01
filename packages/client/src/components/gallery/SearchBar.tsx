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
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {value && (
          <button className="search-clear" onClick={() => onChange("")}>✕</button>
        )}
      </div>
      {value && (
        <span className="search-count">{filtered} / {total}</span>
      )}
    </div>
  );
}
