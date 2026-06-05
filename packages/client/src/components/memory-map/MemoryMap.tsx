import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Map as LeafletMap, Marker } from "leaflet";
import "leaflet/dist/leaflet.css";
import { Photo, PhotoLocation, fetchPhotoLocations, updatePhotoGps } from "../../services/photoApi";
import MediaThumb from "../shared/MediaThumb";
import LocationSearchPanel from "../shared/LocationSearchPanel";

// Module-level Leaflet cache - avoids re-importing on every effect run
let cachedLeaflet: typeof import("leaflet") | null = null;
let leafletLoadPromise: Promise<typeof import("leaflet")> | null = null;

function loadLeaflet(): Promise<typeof import("leaflet")> {
  if (cachedLeaflet) return Promise.resolve(cachedLeaflet);
  if (!leafletLoadPromise) {
    leafletLoadPromise = import("leaflet").then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cachedLeaflet = ((mod as any).default ?? mod) as typeof import("leaflet");
      return cachedLeaflet;
    });
  }
  return leafletLoadPromise;
}

// Pure helper outside component - stable reference
function displayName(p: { name: string; originalName?: string }): string {
  return p.originalName ?? p.name.split("/").pop() ?? p.name;
}

interface Props {
  photos: Photo[];
  groupId?: string;
  onViewPhoto?: (name: string) => void;
  onGpsUpdate?: (name: string, lat: string, lon: string) => void;
}

/** Unified GPS pin — may come from the full Photo list or the fast Cosmos cache */
interface GeoPin {
  name: string;
  lat: number;
  lon: number;
  originalName?: string;
  contentType?: string;
  /** Present when the full Photo object has been loaded */
  photo?: Photo;
}

export default function MemoryMap({ photos, groupId = "", onViewPhoto, onGpsUpdate }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<LeafletMap | null>(null);
  // name -> Marker for O(1) incremental add/remove/update
  const markerMapRef = useRef<Map<string, Marker>>(new Map());

  const [mapReady, setMapReady] = useState(false);
  // Track by name so detail card always shows latest data
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // Fast GPS locations from Cosmos cache (lat/lon only, no URL)
  const [cosmosLocations, setCosmosLocations] = useState<PhotoLocation[]>([]);

  // Fetch GPS locations from Cosmos on mount (fast, independent of full photo list)
  useEffect(() => {
    void fetchPhotoLocations(groupId).then(setCosmosLocations);
  }, [groupId]);

  // Manual GPS editing
  const [editTarget, setEditTarget] = useState<Photo | null>(null);
  const [showLocationSearch, setShowLocationSearch] = useState(false);
  const [manualLat, setManualLat] = useState("");
  const [manualLon, setManualLon] = useState("");
  const [saving, setSaving] = useState(false);
  const [noGpsExpanded, setNoGpsExpanded] = useState(false);
  const [noGpsShowAll, setNoGpsShowAll] = useState(false);

  // Memoised derived state
  const geoPhotos = useMemo<GeoPin[]>(() => {
    // Build a fast lookup of full Photo objects by name
    const photoMap = new Map<string, Photo>(photos.map((p) => [p.name, p]));

    // Merge: Cosmos locations are the source of truth for GPS coords;
    // enrich with full Photo object when available (provides URL, subject, etc.)
    const fromCosmos: GeoPin[] = cosmosLocations
      .filter((l) => !isNaN(l.lat) && !isNaN(l.lon))
      .map((l) => ({
        name: l.name,
        lat: l.lat,
        lon: l.lon,
        originalName: l.originalName,
        contentType: l.contentType,
        photo: photoMap.get(l.name),
      }));

    // Also include photos with GPS that aren't in Cosmos yet (e.g. just uploaded this session)
    const cosmosNames = new Set(cosmosLocations.map((l) => l.name));
    const fromPhotosOnly: GeoPin[] = photos
      .filter((p) => p.gpsLat && p.gpsLon && !cosmosNames.has(p.name))
      .flatMap((p) => {
        const lat = parseFloat(p.gpsLat!);
        const lon = parseFloat(p.gpsLon!);
        if (isNaN(lat) || isNaN(lon)) return [];
        return [{ name: p.name, lat, lon, originalName: p.originalName, contentType: p.contentType, photo: p } satisfies GeoPin];
      });

    return [...fromCosmos, ...fromPhotosOnly];
  }, [cosmosLocations, photos]);

  const noGpsPhotos = useMemo(
    () => photos.filter((p) => !p.gpsLat || !p.gpsLon),
    [photos],
  );

  // Includes coordinates so effect re-runs on GPS updates, not just count changes
  const geoPhotoKey = useMemo(
    () => geoPhotos.map((p) => `${p.name}@${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join("|"),
    [geoPhotos],
  );

  // Init map (once)
  useEffect(() => {
    if (!mapRef.current) return;
    let cancelled = false;
    void loadLeaflet().then((L) => {
      if (cancelled || !mapRef.current || leafletMapRef.current) return;
      const map = L.map(mapRef.current, { center: [30, 105], zoom: 3, zoomControl: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(map);
      leafletMapRef.current = map;
      setMapReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  // Incremental marker updates - only diffs, never rebuilds all
  useEffect(() => {
    if (!mapReady || !leafletMapRef.current || !cachedLeaflet) return;
    const L = cachedLeaflet;
    const map = leafletMapRef.current;
    const markerMap = markerMapRef.current;

    const currentNames = new Set(geoPhotos.map((p) => p.name));

    // Remove stale markers
    for (const [name, marker] of markerMap) {
      if (!currentNames.has(name)) {
        marker.remove();
        markerMap.delete(name);
      }
    }

    // Add new / update moved markers
    let addedNew = false;
    for (const p of geoPhotos) {
      const existing = markerMap.get(p.name);
      if (existing) {
        const pos = existing.getLatLng();
        if (Math.abs(pos.lat - p.lat) > 0.00001 || Math.abs(pos.lng - p.lon) > 0.00001) {
          existing.setLatLng([p.lat, p.lon]);
          existing.off("click");
          existing.on("click", () => setSelectedName(p.name));
        }
      } else {
        // Lightweight dot - no photo URL in icon = no extra network requests
        const icon = L.divIcon({
          className: "",
          html: `<div class="map-marker-pin"></div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        const marker = L.marker([p.lat, p.lon], { icon })
          .bindTooltip(displayName(p), { direction: "top", offset: [0, -10] })
          .addTo(map);
        marker.on("click", () => setSelectedName(p.name));
        markerMap.set(p.name, marker);
        addedNew = true;
      }
    }

    // Fit bounds only when NEW markers appear
    if (addedNew) {
      if (geoPhotos.length === 1) {
        map.setView([geoPhotos[0].lat, geoPhotos[0].lon], 10);
      } else if (geoPhotos.length > 1) {
        const bounds = L.latLngBounds(geoPhotos.map((p) => [p.lat, p.lon]));
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
      }
    }
  }, [geoPhotoKey, mapReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const m of markerMapRef.current.values()) m.remove();
      markerMapRef.current.clear();
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
      }
    };
  }, []);

  // Always resolves to latest pin data via name lookup
  const selected = useMemo(
    () => (selectedName ? geoPhotos.find((p) => p.name === selectedName) ?? null : null),
    [selectedName, geoPhotos],
  );

  const fitAll = () => {
    if (!leafletMapRef.current || !cachedLeaflet || geoPhotos.length === 0) return;
    const L = cachedLeaflet;
    if (geoPhotos.length === 1) {
      leafletMapRef.current.setView([geoPhotos[0].lat, geoPhotos[0].lon], 10);
    } else {
      const bounds = L.latLngBounds(geoPhotos.map((p) => [p.lat, p.lon]));
      leafletMapRef.current.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
    }
  };

  const openEditFor = (photo: Photo) => {
    setEditTarget(photo);
    setShowLocationSearch(false);
    setManualLat(photo.gpsLat ?? "");
    setManualLon(photo.gpsLon ?? "");
  };

  const closeEdit = () => {
    setEditTarget(null);
    setShowLocationSearch(false);
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

  const NO_GPS_PAGE = 24;
  const visibleNoGps = noGpsExpanded
    ? (noGpsShowAll ? noGpsPhotos : noGpsPhotos.slice(0, NO_GPS_PAGE))
    : [];

  return (
    <div className="memory-map-wrap">
      <div className="memory-map-header">
        <span className="memory-map-title">🗺️ 记忆地图</span>
        <span className="memory-map-subtitle">
          {geoPhotos.length > 0
            ? `${geoPhotos.length} 张照片有位置信息`
            : "暂无位置信息——开启相机位置权限后上传的照片将在此显示"}
        </span>
        {geoPhotos.length > 0 && (
          <button className="memory-map-fitall" onClick={fitAll} title="缩放到全部标记">
            ⊕ 全览
          </button>
        )}
      </div>

      <div ref={mapRef} className="memory-map-container" />
      {!mapReady && (
        <div className="memory-map-loading">
          <div className="memory-map-loading-spinner" />
          <span>地图加载中…</span>
        </div>
      )}

      {geoPhotos.length === 0 && (
        <div className="memory-map-empty">
          <div className="memory-map-empty-icon">📍</div>
          <p>上传含有 GPS 信息的照片后，拍摄地点将显示在地图上</p>
          <p className="memory-map-empty-hint">提示：用手机相机并开启位置权限拍摄的照片通常含有 GPS 信息</p>
        </div>
      )}

      {noGpsPhotos.length > 0 && (
        <div className="memory-map-nogps">
          <button
            className="memory-map-nogps-toggle"
            onClick={() => { setNoGpsExpanded((v) => !v); setNoGpsShowAll(false); }}
          >
            <span>📍 为照片手动设置位置</span>
            <span className="memory-map-nogps-count">{noGpsPhotos.length} 张无位置</span>
            <span className="memory-map-nogps-chevron">{noGpsExpanded ? "▲" : "▼"}</span>
          </button>
          {noGpsExpanded && (
            <>
              <div className="memory-map-nogps-grid">
                {visibleNoGps.map((p) => (
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
              {!noGpsShowAll && noGpsPhotos.length > NO_GPS_PAGE && (
                <button className="memory-map-nogps-more" onClick={() => setNoGpsShowAll(true)}>
                  显示全部 {noGpsPhotos.length} 张 ↓
                </button>
              )}
            </>
          )}
        </div>
      )}

      {selected && (
        <div className="memory-map-detail" onClick={() => setSelectedName(null)}>
          <div className="memory-map-detail-card" onClick={(e) => e.stopPropagation()}>
            <button className="memory-map-detail-close" onClick={() => setSelectedName(null)}>✕</button>
            {selected.photo ? (
              <img src={selected.photo.url} alt={displayName(selected)} className="memory-map-detail-img" loading="lazy" />
            ) : (
              <div className="memory-map-detail-img memory-map-detail-img--placeholder">📷</div>
            )}
            <div className="memory-map-detail-info">
              <div className="memory-map-detail-name">{displayName(selected)}</div>
              <div className="memory-map-detail-coords">
                📍 {selected.lat.toFixed(4)}, {selected.lon.toFixed(4)}
              </div>
              {selected.photo?.subject && <div className="memory-map-detail-subject">🏷 {selected.photo.subject}</div>}
              {selected.photo?.createdAt && (
                <div className="memory-map-detail-date">
                  🗓 {new Date(selected.photo.createdAt).toLocaleDateString("zh-CN")}
                </div>
              )}
              <div className="memory-map-detail-actions">
                {onViewPhoto && selected.photo && (
                  <button
                    className="memory-map-detail-jump"
                    onClick={() => { setSelectedName(null); onViewPhoto(selected.name); }}
                  >在时间线中查看</button>
                )}
                {selected.photo && (
                  <button
                    className="memory-map-detail-edit"
                    onClick={() => { setSelectedName(null); openEditFor(selected.photo!); }}
                  >✏️ 修改位置</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {editTarget && createPortal(
        <div className="map-gps-overlay" onClick={closeEdit}>
          <div className="map-gps-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="map-gps-header">
              <span>📍 设置位置</span>
              <button className="map-gps-close" onClick={closeEdit}>✕</button>
            </div>

            <div className="map-gps-photo-row">
              <MediaThumb url={editTarget.url} contentType={editTarget.contentType} alt="" className="map-gps-photo-thumb" />
              <span className="map-gps-photo-name">{displayName(editTarget)}</span>
            </div>

            {/* Shared LocationSearchPanel — same component + search logic as PhotoGallery/FolderView */}
            <div className="map-gps-section-label">
              搜索地址
              {!showLocationSearch && (
                <button className="map-gps-search-toggle" onClick={() => setShowLocationSearch(true)}>
                  搜索 →
                </button>
              )}
            </div>
            {showLocationSearch && (
              <LocationSearchPanel
                saving={saving}
                onSelect={(lat, lon) => void saveGps(lat, lon)}
                onClose={() => setShowLocationSearch(false)}
              />
            )}

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
                onClick={() => void saveGps(manualLat.trim(), manualLon.trim())}
              >{saving ? "保存中…" : "确认"}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
