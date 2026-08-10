import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useId,
  type RefObject,
} from "react";
import { searchLocation, LocationSearchResult } from "../../utils/geocode";
import { readGpsCoordinates } from "../../utils/gpsCoordinates";
import { createLocationSearchRequestLifecycle } from "./locationSearchRequestLifecycle";

interface Props {
  saving: boolean;
  onSelect: (lat: string, lon: string) => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  requestScope?: string;
}

/** Split "天安门广场, 东城区, 北京市, 100010, 中国" into primary + secondary parts */
function splitDisplayName(name: string): { primary: string; secondary: string } {
  const parts = name.split(", ");
  return {
    primary: parts.slice(0, 2).join(", "),
    secondary: parts.slice(2, 5).join(", "),
  };
}

/** Detect "lat, lon" or "lat lon" typed directly in the input */
function parseCoords(q: string): { lat: number; lon: number } | null {
  const m = q.trim().match(/^([^,\s]+)[,\s]+([^,\s]+)$/);
  if (!m) return null;
  return readGpsCoordinates(m[1], m[2]);
}

/**
 * Inline panel for searching a location by name via Nominatim (OpenStreetMap).
 * - 400 ms debounce to reduce API calls
 * - Abort + generation guard to prevent stale results overwriting newer ones
 * - Direct coordinate input support (e.g. "39.9042, 116.4074")
 * - Enter key triggers search immediately
 * - Result names truncated to first 2 segments for readability
 */
export default function LocationSearchPanel({
  saving,
  onSelect,
  onClose,
  returnFocusRef,
  requestScope = "default",
}: Props) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [coordPreview, setCoordPreview] = useState<{ lat: number; lon: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestLifecycleRef = useRef(createLocationSearchRequestLifecycle());
  const requestScopeRef = useRef(requestScope);

  const restoreTriggerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      const target = returnFocusRef?.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  }, [returnFocusRef]);

  const invalidateSearch = useCallback((reason: string) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    requestLifecycleRef.current.invalidate(reason);
  }, []);

  const doSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      invalidateSearch("clear");
      setResults([]);
      setSearching(false);
      return;
    }
    const request = requestLifecycleRef.current.begin();
    setSearching(true);
    void searchLocation(trimmed, { signal: request.signal }).then((res) => {
      if (!requestLifecycleRef.current.isCurrent(request)) return;
      setResults(res);
      setSearching(false);
    }).catch(() => {
      if (!requestLifecycleRef.current.isCurrent(request)) return;
      setResults([]);
      setSearching(false);
    });
  }, [invalidateSearch]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 2 || coordPreview) return;
    timerRef.current = setTimeout(() => doSearch(query), 400);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [coordPreview, doSearch, query]);

  useLayoutEffect(() => {
    if (requestScopeRef.current === requestScope) return;
    requestScopeRef.current = requestScope;
    invalidateSearch("workspace-change");
    setQuery("");
    setCoordPreview(null);
    setResults([]);
    setSearching(false);
  }, [invalidateSearch, requestScope]);

  useEffect(() => (
    () => invalidateSearch("unmount")
  ), [invalidateSearch]);

  const handleQueryChange = (value: string) => {
    const trimmed = value.trim();
    const coords = parseCoords(trimmed);
    invalidateSearch(coords ? "coordinates" : "query-change");
    setQuery(value);
    setCoordPreview(coords);
    setResults([]);
    setSearching(trimmed.length >= 2 && !coords);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (saving) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (coordPreview) {
        onSelect(String(coordPreview.lat), String(coordPreview.lon));
        return;
      }
      doSearch(query);
    }
  };

  const getSearchChoices = () => Array.from(
    panelRef.current?.querySelectorAll<HTMLButtonElement>(
      "button.location-search-coord-preview:not(:disabled), button.location-search-result:not(:disabled)",
    ) ?? [],
  );

  const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const choices = getSearchChoices();
      if (choices.length === 0) return;
      const current = choices.indexOf(e.target as HTMLButtonElement);
      const next = e.key === "ArrowDown"
        ? (current + 1) % choices.length
        : (current <= 0 ? choices.length - 1 : current - 1);
      e.preventDefault();
      e.stopPropagation();
      choices[next].focus({ preventScroll: true });
      return;
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      if (saving) return;
      invalidateSearch("close");
      setResults([]);
      setSearching(false);
      onClose();
      restoreTriggerFocus();
    }
  };

  const trimmedQuery = query.trim();
  const statusText = searching
    ? "正在搜索位置"
    : (!coordPreview && trimmedQuery.length >= 2 && results.length === 0
        ? "未找到匹配地点，请换个关键词"
        : (results.length > 0 ? `找到 ${results.length} 个位置` : ""));

  return (
    <div
      ref={panelRef}
      className="location-search-panel"
      onKeyDown={handlePanelKeyDown}
      aria-busy={searching || saving}
    >
      <div className="location-search-top">
        <label className="location-search-label" htmlFor={inputId}>搜索照片位置</label>
        <input
          id={inputId}
          autoFocus
          type="search"
          className="location-search-input"
          placeholder="地点名称，或直接输入坐标：39.90, 116.39"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onKeyDown={handleInputKeyDown}
          disabled={saving}
        />
      </div>

      {/* Coordinate direct-use shortcut */}
      {coordPreview && (
        <button
          type="button"
          className="location-search-coord-preview"
          onClick={() => !saving && onSelect(String(coordPreview.lat), String(coordPreview.lon))}
          disabled={saving}
          aria-label={`使用坐标：纬度 ${coordPreview.lat.toFixed(5)}，经度 ${coordPreview.lon.toFixed(5)}`}
        >
          <span className="location-coord-icon">📍</span>
          <span className="location-coord-text">
            使用坐标&nbsp;
            <strong>{coordPreview.lat.toFixed(5)}, {coordPreview.lon.toFixed(5)}</strong>
          </span>
          <span className="location-coord-confirm">按 Enter 或点击确认</span>
        </button>
      )}

      <p
        className="location-search-hint"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {statusText}
      </p>

      {!coordPreview && results.length > 0 && (
        <ul className="location-search-results" aria-label="地点搜索结果">
          {results.map((r, i) => {
            const { primary, secondary } = splitDisplayName(r.displayName);
            const coordinates = `${r.lat.toFixed(4)}°, ${r.lon.toFixed(4)}°`;
            const stableName = r.displayName.trim() || coordinates;
            const mainLabel = (r.shortName && r.shortName !== r.displayName ? r.shortName : primary) || coordinates;
            return (
              <li key={`${r.lat}:${r.lon}:${i}`}>
                <button
                  type="button"
                  className="location-search-result"
                  onClick={() => !saving && onSelect(String(r.lat), String(r.lon))}
                  disabled={saving}
                  aria-label={`选择位置：${stableName}`}
                >
                  <span className="location-result-name" title={r.displayName}>{mainLabel}</span>
                  {secondary && (
                    <span className="location-result-secondary">{secondary}</span>
                  )}
                  <span className="location-result-coords">
                    {coordinates}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
