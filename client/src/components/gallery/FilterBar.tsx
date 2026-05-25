

export interface FilterState {
  name: string;
  subject: string;
  uploader: string;
  dateFrom: string;
  dateTo: string;
}

export const emptyFilter: FilterState = {
  name: "",
  subject: "",
  uploader: "",
  dateFrom: "",
  dateTo: "",
};

interface Props {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  uploaders: string[];
  subjects: string[];
  total: number;
  filtered: number;
}

export default function FilterBar({
  filters,
  onChange,
  uploaders,
  subjects,
  total,
  filtered,
}: Props) {
  const set = (key: keyof FilterState, value: string) =>
    onChange({ ...filters, [key]: value });

  const hasAny = filters.name || filters.subject || filters.uploader || filters.dateFrom || filters.dateTo;

  return (
    <div className="filter-bar">
      <div className="filter-main-row">
        <div className="search-input-wrap">
          <svg className="search-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="8.5" cy="8.5" r="5" stroke="#9ca3af" strokeWidth="1.6"/>
            <line x1="12.5" y1="12.5" x2="16.5" y2="16.5" stroke="#9ca3af" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          <input
            type="search"
            className="search-input"
            placeholder="Search by name..."
            value={filters.name}
            onChange={(e) => set("name", e.target.value)}
          />
          {filters.name && (
            <button className="search-clear" onClick={() => set("name", "")}>✕</button>
          )}
        </div>

        {hasAny && (
          <button className="filter-clear-btn" onClick={() => onChange(emptyFilter)}>
            Clear all
          </button>
        )}

        {hasAny && (
          <span className="search-count">{filtered} / {total}</span>
        )}
      </div>

      <div className="filter-panel">
        <label className="filter-field">
          <span>Subject</span>
          <input
            type="text"
            list="subjects-list"
            placeholder="Any subject"
            value={filters.subject}
            onChange={(e) => set("subject", e.target.value)}
          />
          <datalist id="subjects-list">
            {subjects.map((s) => <option key={s} value={s} />)}
          </datalist>
        </label>

        <label className="filter-field">
          <span>Uploader</span>
          <select
            style={{ color: filters.uploader ? "#374151" : "#9ca3af" }}
            value={filters.uploader}
            onChange={(e) => set("uploader", e.target.value)}
          >
            <option value="">Anyone</option>
            {uploaders.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>

        <label className="filter-field">
          <span>From</span>
          <input
            type="date"
            style={{ color: filters.dateFrom ? "#374151" : "#9ca3af" }}
            value={filters.dateFrom}
            onChange={(e) => set("dateFrom", e.target.value)}
          />
        </label>

        <label className="filter-field">
          <span>To</span>
          <input
            type="date"
            style={{ color: filters.dateTo ? "#374151" : "#9ca3af" }}
            value={filters.dateTo}
            onChange={(e) => set("dateTo", e.target.value)}
          />
        </label>
      </div>
    </div>
  );
}
