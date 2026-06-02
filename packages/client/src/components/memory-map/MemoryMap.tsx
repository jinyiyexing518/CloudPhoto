import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Map, Marker } from "leaflet";
import "leaflet/dist/leaflet.css";
import { Photo } from "../../services/photoApi";
import { updatePhotoGps } from "../../services/photoApi";
import MediaThumb from "../shared/MediaThumb";

interface Props {
  photos: Photo[];
  onViewPhoto?: (name: string) => void;
  onGpsUpdate?: (name: string, lat: string, lon: string) => void;
}

interface GeoPhoto extends Photo {
  lat: number;
  lon: number;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

export default function MemoryMap({ photos, onViewPhoto, onGpsUpdate }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<Map | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const [selected, setSelected] = useState<GeoPhoto | null>(null);

  // ── Manual GPS editing ─────────────────────────────────────────────────────
  const [editTarget, setEditTarget] = useState<Photo | null>(null);
  const [addressQuery, setAddressQuery] = useState("");
  const [geocodeResults, setGeocodeResults] = useState<NominatimResult[]>([]);
  const [geocoding, setGeocoding] = useState(false);
  const [manualLat, setManualLat] = useState("");
  const [manualLon, setManualLon] = useState("");
  const [saving, setSaving] = useState(false);
  const [noGpsExpanded, setNoGpsExpanded] = useState(false);

  const geoPhotos: GeoPhoto[] = photos
    .filter((p) => p.gpsLat && p.gpsLon)
    .map((p) => ({ ...p, lat: parseFloat(p.gpsLat!), lon: parseFloat(p.gpsLon!) }))
    .filter((p) => !isNaN(p.lat) && !isNaN(p.lon));

  const noGpsPhotos = photos.filter(
    (p) => !p.gpsLat || !p.gpsLon,
  );

  useEffect(() => {
    if (!mapRef.current) return;
    let stale = false;

    import("leaflet").then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const L = ((mod as any).default ?? mod) as typeof import("leaflet");
      if (stale || !mapRef.current) return;

      // ── Initialize map on first run ─────────────────────────────────────
      if (!leafletMap.current) {
        const map = L.map(mapRef.current, {
          center: [20, 0],
          zoom: 2,
        });
        leafletMap.current = map;
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap contributors",
          maxZoom: 19,
        }).addTo(map);
      }

      // ── Always rebuild markers so they're up-to-date ───────────────────
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      geoPhotos.forEach((p) => {
        const icon = L.divIcon({
          className: "map-photo-marker",
          html: `<img src="${p.url}" alt="" />`,
          iconSize: [48, 48],
          iconAnchor: [24, 24],
        });
        const marker = L.marker([p.lat, p.lon], { icon }).addTo(leafletMap.current!);
        marker.on("click", () => setSelected(p));
        markersRef.current.push(marker);
      });

      // ── Fit view ────────────────────────────────────────────────────────
      if (geoPhotos.length === 1) {
        leafletMap.current!.setView([geoPhotos[0].lat, geoPhotos[0].lon], 5);
      } else if (geoPhotos.length > 1) {
        const bounds = L.latLngBounds(geoPhotos.map((p) => [p.lat, p.lon]));
        leafletMap.current!.fitBounds(bounds, { padding: [40, 40] });
      }
    });

    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoPhotos.length]);

  // Destroy map only on component unmount
  useEffect(() => {
    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      if (leafletMap.current) {
        leafletMap.current.remove();
        leafletMap.current = null;
      }
    };
  }, []);

  // ── Geocoding via Nominatim (free, no key required) ───────────────────────
  const doGeocode = async () => {
    if (!addressQuery.trim()) return;
    setGeocoding(true);
    setGeocodeResults([]);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addressQuery)}&format=json&limit=5&accept-language=zh-CN`,
        { headers: { "Accept-Language": "zh-CN,zh;q=0.9" } },
      );
      const data = (await res.json()) as NominatimResult[];
      setGeocodeResults(data);
    } catch {
      setGeocodeResults([]);
    } finally {
      setGeocoding(false);
    }
  };

  const openEditFor = (photo: Photo) => {
    setEditTarget(photo);
    setAddressQuery("");
    setGeocodeResults([]);
    setManualLat(photo.gpsLat ?? "");
    setManualLon(photo.gpsLon ?? "");
  };

  const closeEdit = () => {
    setEditTarget(null);
    setAddressQuery("");
    setGeocodeResults([]);
    setManualLat("");
    setManualLon("");
  };

  const saveGps = async (lat: string, lon: string) => {
    if (!editTarget) return;
    setSaving(true);
    try {
      await updatePhotoGps(editTarget.name, lat, lon);
      onGpsUpdate?.(editTarget.name, lat, lon);
      closeEdit();
    } finally {
      setSaving(false);
    }
  };

  const canSaveManual =
    manualLat.trim() !== "" &&
    manualLon.trim() !== "" &&
    !isNaN(parseFloat(manualLat)) &&
    !isNaN(parseFloat(manualLon));

  const displayName = (p: Photo) =>
    p.originalName ?? p.name.split("/").pop() ?? p.name;

  return (
    <div className="memory-map-wrap">
      <div className="memory-map-header">
        <span className="memory-map-title">🗺️ 记忆地图</span>
        <span className="memory-map-subtitle">
          {geoPhotos.length > 0
            ? `${geoPhotos.length} 张照片有位置信息`
            : "暂无位置信息——开启相机位置权限后上传的照片将在此显示"}
        </span>
      </div>

      <div ref={mapRef} className="memory-map-container" />

      {geoPhotos.length === 0 && (
        <div className="memory-map-empty">
          <div className="memory-map-empty-icon">📍</div>
          <p>上传含有 GPS 信息的照片后，拍摄地点将显示在地图上</p>
          <p className="memory-map-empty-hint">提示：使用手机相机并开启位置权限拍摄的照片通常含有 GPS 信息</p>
        </div>
      )}

      {/* ── No-GPS photos section ─────────────────────────────────────────── */}
      {noGpsPhotos.length > 0 && (
        <div className="memory-map-nogps">
          <button
            className="memory-map-nogps-toggle"
            onClick={() => setNoGpsExpanded((v) => !v)}
          >
            <span>📍 为照片手动设置位置</span>
            <span className="memory-map-nogps-count">{noGpsPhotos.length} 张无位置</span>
            <span className="memory-map-nogps-chevron">{noGpsExpanded ? "▲" : "▼"}</span>
          </button>
          {noGpsExpanded && (
            <div className="memory-map-nogps-grid">
              {noGpsPhotos.map((p) => (
                <button
                  key={p.name}
                  className="memory-map-nogps-item"
                  onClick={() => openEditFor(p)}
                  title={displayName(p)}
                >
                  <MediaThumb url={p.url} contentType={p.contentType} alt="" className="memory-map-nogps-thumb" />
                  <span className="memory-map-nogps-name">{displayName(p)}</span>
                  <span className="memory-map-nogps-badge">📍</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Map marker detail sheet ───────────────────────────────────────── */}
      {selected && (
        <div className="memory-map-detail" onClick={() => setSelected(null)}>
          <div className="memory-map-detail-card" onClick={(e) => e.stopPropagation()}>
            <button className="memory-map-detail-close" onClick={() => setSelected(null)}>✕</button>
            <img src={selected.url} alt={displayName(selected)} className="memory-map-detail-img" />
            <div className="memory-map-detail-info">
              <div className="memory-map-detail-name">{displayName(selected)}</div>
              <div className="memory-map-detail-coords">
                📍 {selected.lat.toFixed(4)}, {selected.lon.toFixed(4)}
              </div>
              {selected.subject && <div className="memory-map-detail-subject">🏷 {selected.subject}</div>}
              <div className="memory-map-detail-date">
                🗓 {new Date(selected.createdAt ?? selected.lastModified ?? "").toLocaleDateString("zh-CN")}
              </div>
              <div className="memory-map-detail-actions">
                {onViewPhoto && (
                  <button
                    className="memory-map-detail-jump"
                    onClick={() => { setSelected(null); onViewPhoto(selected.name); }}
                  >在时间线中查看</button>
                )}
                <button
                  className="memory-map-detail-edit"
                  onClick={() => { setSelected(null); openEditFor(selected); }}
                >✏️ 修改位置</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── GPS edit dialog ───────────────────────────────────────────────── */}
      {editTarget && createPortal(
        <div className="map-gps-overlay" onClick={closeEdit}>
          <div className="map-gps-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="map-gps-header">
              <span>📍 设置位置</span>
              <button className="map-gps-close" onClick={closeEdit}>✕</button>
            </div>

            {/* Photo preview */}
            <div className="map-gps-photo-row">
              <MediaThumb url={editTarget.url} contentType={editTarget.contentType} alt="" className="map-gps-photo-thumb" />
              <span className="map-gps-photo-name">{displayName(editTarget)}</span>
            </div>

            {/* Address search */}
            <div className="map-gps-section-label">搜索地址</div>
            <div className="map-gps-search-row">
              <input
                className="map-gps-input"
                placeholder="输入地址、城市或地名…"
                value={addressQuery}
                onChange={(e) => setAddressQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doGeocode()}
              />
              <button
                className="map-gps-search-btn"
                onClick={doGeocode}
                disabled={geocoding || !addressQuery.trim()}
              >{geocoding ? "…" : "搜索"}</button>
            </div>
            {geocodeResults.length > 0 && (
              <ul className="map-gps-results">
                {geocodeResults.map((r, i) => (
                  <li key={i}>
                    <button
                      className="map-gps-result-item"
                      onClick={() => saveGps(r.lat, r.lon)}
                      disabled={saving}
                    >
                      <span className="map-gps-result-name">{r.display_name}</span>
                      <span className="map-gps-result-coords">{parseFloat(r.lat).toFixed(4)}, {parseFloat(r.lon).toFixed(4)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {geocodeResults.length === 0 && addressQuery && !geocoding && (
              <p className="map-gps-no-result">未找到结果，请尝试不同关键词</p>
            )}

            {/* Manual input */}
            <div className="map-gps-divider">或手动输入坐标</div>
            <div className="map-gps-manual-row">
              <label className="map-gps-coord-label">
                <span>纬度</span>
                <input
                  className="map-gps-input"
                  placeholder="例如 39.9042"
                  value={manualLat}
                  onChange={(e) => setManualLat(e.target.value)}
                  type="number"
                  step="any"
                />
              </label>
              <label className="map-gps-coord-label">
                <span>经度</span>
                <input
                  className="map-gps-input"
                  placeholder="例如 116.4074"
                  value={manualLon}
                  onChange={(e) => setManualLon(e.target.value)}
                  type="number"
                  step="any"
                />
              </label>
            </div>
            <div className="map-gps-footer">
              <button className="map-gps-cancel" onClick={closeEdit}>取消</button>
              <button
                className="map-gps-confirm"
                disabled={!canSaveManual || saving}
                onClick={() => saveGps(manualLat.trim(), manualLon.trim())}
              >{saving ? "保存中…" : "确认"}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
