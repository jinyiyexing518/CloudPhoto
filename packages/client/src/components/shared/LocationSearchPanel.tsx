import { useState, useRef, useEffect, useCallback, type RefObject } from "react";
import { searchLocation, LocationSearchResult } from "../../utils/geocode";
import { readGpsCoordinates } from "../../utils/gpsCoordinates";

interface Props {
  saving: boolean;
  onSelect: (lat: string, lon: string) => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
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
 * - Request-ID guard to prevent stale results overwriting newer ones
 * - Direct coordinate input support (e.g. "39.9042, 116.4074")
 * - Enter key triggers search immediately
 * - Result names truncated to first 2 segments for readability
 */
export default function LocationSearchPanel({ saving, onSelect, onClose, returnFocusRef }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [coordPreview, setCoordPreview] = useState<{ lat: number; lon: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  const restoreTriggerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      const target = returnFocusRef?.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  }, [returnFocusRef]);

  const doSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const id = ++reqIdRef.current;
    setSearching(true);
    void searchLocation(trimmed).then((res) => {
      if (id !== reqIdRef.current) return; // stale — discard
      setResults(res);
      setSearching(false);
    });
  }, []);

  useEffect(() => {
    const trimmed = query.trim();

    // Coordinate direct-input detection
    const coords = parseCoords(trimmed);
    setCoordPreview(coords);

    if (!trimmed || trimmed.length < 2) {
      setResults([]);
      setSearching(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }
    if (coords) {
      // User typed raw coordinates — no need to search
      setResults([]);
      setSearching(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }
    setSearching(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(query), 400);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, doSearch]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (timerRef.current) clearTimeout(timerRef.current);
      if (coordPreview) {
        onSelect(String(coordPreview.lat), String(coordPreview.lon));
        return;
      }
      doSearch(query);
    }
  };

  const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (saving) return;
      onClose();
      restoreTriggerFocus();
    }
  };

  return (
    <div className="location-search-panel" onKeyDown={handlePanelKeyDown}>
      <div className="location-search-top">
        <input
          autoFocus
          type="search"
          className="location-search-input"
          placeholder="地点名称，或直接输入坐标：39.90, 116.39"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
        >
          <span className="location-coord-icon">📍</span>
          <span className="location-coord-text">
            使用坐标&nbsp;
            <strong>{coordPreview.lat.toFixed(5)}, {coordPreview.lon.toFixed(5)}</strong>
          </span>
          <span className="location-coord-confirm">按 Enter 或点击确认</span>
        </button>
      )}

      {searching && <p className="location-search-hint">搜索中…</p>}

      {!coordPreview && !searching && query.trim().length >= 2 && results.length === 0 && (
        <p className="location-search-hint">未找到匹配地点，请换个关键词</p>
      )}

      {!coordPreview && results.length > 0 && (
        <ul className="location-search-results">
          {results.map((r, i) => {
            const { primary, secondary } = splitDisplayName(r.displayName);
            // Prefer server-provided shortName; fall back to local split
            const mainLabel = r.shortName && r.shortName !== r.displayName ? r.shortName : primary;
            return (
              <li key={`${r.lat}:${r.lon}:${i}`}>
                <button
                  type="button"
                  className="location-search-result"
                  onClick={() => !saving && onSelect(String(r.lat), String(r.lon))}
                  disabled={saving}
                  aria-label={`选择位置：${r.displayName}`}
                >
                  <span className="location-result-name" title={r.displayName}>{mainLabel}</span>
                  {secondary && (
                    <span className="location-result-secondary">{secondary}</span>
                  )}
                  <span className="location-result-coords">
                    {r.lat.toFixed(4)}°, {r.lon.toFixed(4)}°
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
