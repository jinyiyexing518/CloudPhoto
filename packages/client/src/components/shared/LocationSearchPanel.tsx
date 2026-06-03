import { useState, useRef, useEffect } from "react";
import { searchLocation, LocationSearchResult } from "../../utils/geocode";

interface Props {
  saving: boolean;
  onSelect: (lat: string, lon: string) => void;
  onClose: () => void;
}

/**
 * Inline panel for searching a location by name via Nominatim (OpenStreetMap).
 * Renders a search input with debounced results; calls onSelect(lat, lon) on pick.
 */
export default function LocationSearchPanel({ saving, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void searchLocation(query).then((res) => {
        setResults(res);
        setSearching(false);
      });
    }, 500);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query]);

  return (
    <div className="location-search-panel">
      <div className="location-search-top">
        <input
          autoFocus
          type="search"
          className="location-search-input"
          placeholder="搜索地点，如：北京天安门广场"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={saving}
        />
        <button className="location-search-close" onClick={onClose} disabled={saving}>
          ✕
        </button>
      </div>

      {searching && <p className="location-search-hint">搜索中…</p>}

      {!searching && query.trim() && results.length === 0 && (
        <p className="location-search-hint">未找到匹配地点</p>
      )}

      {results.length > 0 && (
        <ul className="location-search-results">
          {results.map((r, i) => (
            <li
              key={i}
              className="location-search-result"
              onClick={() => !saving && onSelect(String(r.lat), String(r.lon))}
            >
              <span className="location-result-name">{r.displayName}</span>
              <span className="location-result-coords">
                {r.lat.toFixed(4)}°, {r.lon.toFixed(4)}°
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
