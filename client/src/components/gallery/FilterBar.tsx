
import { useState, useEffect, useRef } from "react";

export interface FilterState {
  name: string;
  subject: string;
  uploader: string;
  dateFrom: string;
  dateTo: string;
  favoriteOnly: boolean;
}

export const emptyFilter: FilterState = {
  name: "",
  subject: "",
  uploader: "",
  dateFrom: "",
  dateTo: "",
  favoriteOnly: false,
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
  // Debounced name search: local state updates immediately; parent notified after 300ms
  const [localName, setLocalName] = useState(filters.name);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync when parent clears filters externally (e.g. "Clear all")
  useEffect(() => { setLocalName(filters.name); }, [filters.name]);

  const handleNameChange = (value: string) => {
    setLocalName(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange({ ...filters, name: value }), 300);
  };

  const set = (key: keyof FilterState, value: string | boolean) =>
    onChange({ ...filters, [key]: value });

  const hasAny = filters.name || filters.subject || filters.uploader || filters.dateFrom || filters.dateTo || filters.favoriteOnly;

  // Active filter chips (all except name which has inline clear)
  const activeChips: { label: string; key: keyof FilterState }[] = [];
  if (filters.subject) activeChips.push({ label: `主题: ${filters.subject}`, key: "subject" });
  if (filters.uploader) activeChips.push({ label: `上传者: ${filters.uploader}`, key: "uploader" });
  if (filters.dateFrom) activeChips.push({ label: `从: ${filters.dateFrom}`, key: "dateFrom" });
  if (filters.dateTo) activeChips.push({ label: `至: ${filters.dateTo}`, key: "dateTo" });
  if (filters.favoriteOnly) activeChips.push({ label: "仅收藏", key: "favoriteOnly" });

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
            value={localName}
            onChange={(e) => handleNameChange(e.target.value)}
          />
          {localName && (
            <button className="search-clear" onClick={() => handleNameChange("")}>✕</button>
          )}
        </div>

        {hasAny && (
          <button className="filter-clear-btn" onClick={() => { onChange(emptyFilter); setLocalName(""); }}>
            Clear all
          </button>
        )}

        <button
          className={`filter-toggle-btn${filters.favoriteOnly ? " active" : ""}`}
          onClick={() => set("favoriteOnly", !filters.favoriteOnly)}
          type="button"
        >
          ★ 仅收藏
        </button>

        {hasAny && (
          <span className="search-count">{filtered} / {total}</span>
        )}
      </div>

      {/* Active filter chips */}
      {activeChips.length > 0 && (
        <div className="filter-chips">
          {activeChips.map((chip) => (
            <span key={chip.key} className="filter-chip">
              {chip.label}
              <button className="filter-chip-remove" onClick={() => set(chip.key, chip.key === "favoriteOnly" ? false : "")}>✕</button>
            </span>
          ))}
        </div>
      )}

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
