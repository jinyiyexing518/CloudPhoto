
import { useState, useLayoutEffect, useRef } from "react";
import {
  createFilterNameDebouncer,
  type FilterNameDebouncer,
} from "./filterNameDebounce";

export interface FilterState {
  name: string;
  subject: string;
  uploader: string;
  dateFrom: string;
  dateTo: string;
  favoriteOnly: boolean;
  missingSubjectOnly: boolean;
  uncategorizedOnly: boolean;
  noGpsOnly: boolean;
  folder: string;
}

export const emptyFilter: FilterState = {
  name: "",
  subject: "",
  uploader: "",
  dateFrom: "",
  dateTo: "",
  favoriteOnly: false,
  missingSubjectOnly: false,
  uncategorizedOnly: false,
  noGpsOnly: false,
  folder: "",
};

export type GridSize = "sm" | "md" | "lg";

interface Props {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  uploaders: string[];
  subjects: string[];
  total: number;
  filtered: number;
  gridSize?: GridSize;
  onGridSizeChange?: (size: GridSize) => void;
  variant?: "default" | "sidebar";
  resetVersion?: number;
}

export default function FilterBar({
  filters,
  onChange,
  uploaders,
  subjects,
  total,
  filtered,
  gridSize = "md",
  onGridSizeChange,
  variant = "default",
  resetVersion = 0,
}: Props) {
  // Debounced name search: local state updates immediately; parent notified after 300ms
  const [localName, setLocalName] = useState(filters.name);
  const filtersRef = useRef(filters);
  const onChangeRef = useRef(onChange);
  const previousFilterNameRef = useRef(filters.name);
  const previousResetVersionRef = useRef(resetVersion);
  const nameDebouncerRef = useRef<FilterNameDebouncer | null>(null);
  filtersRef.current = filters;
  onChangeRef.current = onChange;

  if (nameDebouncerRef.current === null) {
    nameDebouncerRef.current = createFilterNameDebouncer({
      readFilters: () => filtersRef.current,
      readOnChange: () => onChangeRef.current,
    });
  }

  // External name changes and shared emptyFilter resets invalidate pending input.
  useLayoutEffect(() => {
    const nameChanged = previousFilterNameRef.current !== filters.name;
    const resetChanged = previousResetVersionRef.current !== resetVersion;
    previousFilterNameRef.current = filters.name;
    previousResetVersionRef.current = resetVersion;
    if (nameChanged || resetChanged || filters === emptyFilter) {
      nameDebouncerRef.current?.cancel();
      setLocalName(filters.name);
    }
  }, [filters, resetVersion]);

  useLayoutEffect(
    () => () => nameDebouncerRef.current?.cancel(),
    [],
  );

  const handleNameChange = (value: string) => {
    setLocalName(value);
    nameDebouncerRef.current?.schedule(value);
  };

  const set = (key: keyof FilterState, value: string | boolean) =>
    onChangeRef.current({ ...filtersRef.current, [key]: value });

  const clearAll = () => {
    nameDebouncerRef.current?.cancel();
    filtersRef.current = emptyFilter;
    setLocalName("");
    onChangeRef.current(emptyFilter);
  };

  const hasAny = filters.name || filters.subject || filters.uploader || filters.dateFrom || filters.dateTo || filters.favoriteOnly || filters.missingSubjectOnly || filters.uncategorizedOnly || filters.noGpsOnly || filters.folder;

  // Active filter chips (all except name which has inline clear)
  const activeChips: { label: string; key: keyof FilterState }[] = [];
  if (filters.subject) activeChips.push({ label: `主题: ${filters.subject}`, key: "subject" });
  if (filters.uploader) activeChips.push({ label: `上传者: ${filters.uploader}`, key: "uploader" });
  if (filters.dateFrom) activeChips.push({ label: `从: ${filters.dateFrom}`, key: "dateFrom" });
  if (filters.dateTo) activeChips.push({ label: `至: ${filters.dateTo}`, key: "dateTo" });
  if (filters.favoriteOnly) activeChips.push({ label: "仅收藏", key: "favoriteOnly" });
  if (filters.missingSubjectOnly) activeChips.push({ label: "缺少主题", key: "missingSubjectOnly" });
  if (filters.uncategorizedOnly) activeChips.push({ label: "未分类", key: "uncategorizedOnly" });
  if (filters.noGpsOnly) activeChips.push({ label: "无GPS", key: "noGpsOnly" });
  if (filters.folder) activeChips.push({ label: `📁 ${filters.folder}`, key: "folder" });

  return (
    <div className={`filter-bar filter-bar--${variant}${variant === "sidebar" ? " auth-native-control-scope" : ""}`}>
      <div className="filter-main-row">
        <div className="filter-search-row">
          <div className="search-input-wrap">
            <svg className="search-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="8.5" cy="8.5" r="5" stroke="#9ca3af" strokeWidth="1.6"/>
              <line x1="12.5" y1="12.5" x2="16.5" y2="16.5" stroke="#9ca3af" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            <input
              type="search"
              className="search-input"
              placeholder="搜索名称..."
              aria-label="按名称搜索照片"
              value={localName}
              onChange={(e) => handleNameChange(e.target.value)}
            />
            {localName && (
              <button type="button" className="search-clear" onClick={() => handleNameChange("")} aria-label="清空名称搜索">✕</button>
            )}
          </div>

          {hasAny && (
            <button type="button" className="filter-clear-btn" onClick={clearAll}>
              清空全部
            </button>
          )}
        </div>

        <div className="filter-quick-controls">
          <button
            className={`filter-toggle-btn${filters.favoriteOnly ? " active" : ""}`}
            onClick={() => set("favoriteOnly", !filters.favoriteOnly)}
            type="button"
          >
            ★ 仅收藏
          </button>

          <button
            className={`filter-toggle-btn${filters.missingSubjectOnly ? " active" : ""}`}
            onClick={() => set("missingSubjectOnly", !filters.missingSubjectOnly)}
            type="button"
          >
            🏷 无主题
          </button>

          <button
            className={`filter-toggle-btn${filters.uncategorizedOnly ? " active" : ""}`}
            onClick={() => set("uncategorizedOnly", !filters.uncategorizedOnly)}
            type="button"
          >
            📂 未分类
          </button>

          <button
            className={`filter-toggle-btn${filters.noGpsOnly ? " active" : ""}`}
            onClick={() => set("noGpsOnly", !filters.noGpsOnly)}
            type="button"
          >
            📍 无GPS
          </button>

          {hasAny && (
            <span className="search-count">{filtered} / {total}</span>
          )}

          {onGridSizeChange && (
            <div className="grid-size-toggle">
              {(["sm", "md", "lg"] as GridSize[]).map((size) => (
                <button
                  key={size}
                  type="button"
                  className={`grid-size-btn${gridSize === size ? " active" : ""}`}
                  onClick={() => onGridSizeChange(size)}
                  aria-label={size === "sm" ? "小缩略图" : size === "md" ? "中缩略图" : "大缩略图"}
                  aria-pressed={gridSize === size}
                  title={size === "sm" ? "小缩略图" : size === "md" ? "中缩略图" : "大缩略图"}
                >
                  {size === "sm" ? "⊞" : size === "md" ? "⊟" : "▣"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Active filter chips */}
      {activeChips.length > 0 && (
        <div className="filter-chips">
          {activeChips.map((chip) => (
            <span key={chip.key} className="filter-chip">
              <span className="filter-chip-label">{chip.label}</span>
              <button
                type="button"
                className="filter-chip-remove"
                onClick={() => set(chip.key, chip.key === "favoriteOnly" ? false : "")}
                aria-label={`移除${chip.label}筛选`}
              >✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="filter-panel">
        <label className="filter-field">
          <span>主题</span>
          <input
            type="text"
            list="subjects-list"
            placeholder="任意主题"
            value={filters.subject}
            onChange={(e) => set("subject", e.target.value)}
          />
          <datalist id="subjects-list">
            {subjects.map((s) => <option key={s} value={s} />)}
          </datalist>
        </label>

        <label className="filter-field">
          <span>上传者</span>
          <select
            style={{ color: filters.uploader ? "#374151" : "#9ca3af" }}
            value={filters.uploader}
            onChange={(e) => set("uploader", e.target.value)}
          >
            <option value="">任何人</option>
            {uploaders.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>

        <label className="filter-field">
          <span>开始日期</span>
          <input
            type="date"
            style={{ color: filters.dateFrom ? "#374151" : "#9ca3af" }}
            value={filters.dateFrom}
            onChange={(e) => set("dateFrom", e.target.value)}
          />
        </label>

        <label className="filter-field">
          <span>截止日期</span>
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
