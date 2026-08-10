import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Map as LeafletMap, Marker } from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  Photo,
  PhotoLocation,
  fetchPhotoLocations,
  isAuthorizationDriftError,
  updatePhotoGps,
} from "../../services/photoApi";
import MediaThumb from "../shared/MediaThumb";
import LocationSearchPanel from "../shared/LocationSearchPanel";
import { useToast } from "../../contexts/ToastContext";
import { readGpsCoordinates } from "../../utils/gpsCoordinates";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";
import {
  createMapTooltipContent,
  getMapMarkerLabel,
  getPhotoDisplayName as displayName,
} from "./memoryMapAccessibility";

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

interface Props {
  photos: Photo[];
  groupId?: string;
  photosGroupId?: string | null;
  locationIndexRevision?: number;
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

interface MarkerRegistration {
  marker: Marker;
  element: HTMLElement;
  click: () => void;
  keydown: (event: KeyboardEvent) => void;
  workspace: string;
}

function removeMarkerRegistration(registration: MarkerRegistration): void {
  registration.element.removeEventListener("keydown", registration.keydown);
  registration.marker.off("click", registration.click);
  registration.marker.remove();
}

export default function MemoryMap({
  photos,
  groupId = "",
  photosGroupId = groupId,
  locationIndexRevision = 0,
  onViewPhoto,
  onGpsUpdate,
}: Props) {
  const showToast = useToast();
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<LeafletMap | null>(null);
  // name -> marker DOM/listeners for O(1) incremental updates and complete cleanup
  const markerMapRef = useRef<Map<string, MarkerRegistration>>(new Map());
  const detailLayerRef = useRef<HTMLDivElement>(null);
  const detailDialogRef = useRef<HTMLDivElement>(null);
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  const detailRestoreFocusRef = useRef<HTMLElement | null>(null);
  const editLayerRef = useRef<HTMLDivElement>(null);
  const editDialogRef = useRef<HTMLDivElement>(null);
  const manualLatRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const editRestoreFocusRef = useRef<HTMLElement | null>(null);
  const editSessionRef = useRef(0);
  const mountedRef = useRef(true);
  const workspaceRef = useRef(groupId);
  const pendingMarkerFocusRef = useRef<{ name: string; expiresAt: number } | null>(null);
  workspaceRef.current = groupId;

  const [mapReady, setMapReady] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<{ workspace: string; name: string } | null>(null);

  // Fast GPS locations from Cosmos cache (lat/lon only, no URL)
  const [cosmosLocationState, setCosmosLocationState] = useState<{
    workspace: string;
    locations: PhotoLocation[];
  }>({ workspace: groupId, locations: [] });
  const cosmosLocations = cosmosLocationState.workspace === groupId
    ? cosmosLocationState.locations
    : [];

  // Fetch GPS locations from Cosmos on mount (fast, independent of full photo list)
  useEffect(() => {
    const controller = new AbortController();
    const workspace = groupId;
    setCosmosLocationState({ workspace, locations: [] });
    void fetchPhotoLocations(workspace, { signal: controller.signal }).then(
      (locations) => {
        if (!controller.signal.aborted) setCosmosLocationState({ workspace, locations });
      },
      (error: unknown) => {
        if (
          controller.signal.aborted
          || isAuthorizationDriftError(error)
          || (error instanceof Error && error.name === "AbortError")
        ) return;
        showToast(error instanceof Error ? error.message : "加载照片位置失败", "error");
      },
    );
    return () => controller.abort(new DOMException("Workspace changed", "AbortError"));
  }, [groupId, locationIndexRevision, showToast]);

  // Manual GPS editing
  const [editTarget, setEditTarget] = useState<{ workspace: string; photo: Photo } | null>(null);
  const [showLocationSearch, setShowLocationSearch] = useState(false);
  const [manualLat, setManualLat] = useState("");
  const [manualLon, setManualLon] = useState("");
  const [saving, setSaving] = useState(false);
  const [noGpsExpanded, setNoGpsExpanded] = useState(false);
  const [noGpsShowAll, setNoGpsShowAll] = useState(false);

  // Memoised derived state
  const geoPhotos = useMemo<GeoPin[]>(() => {
    const currentPhotos = photosGroupId === groupId ? photos : [];
    // Build a fast lookup of full Photo objects by name
    const photoMap = new Map<string, Photo>(currentPhotos.map((p) => [p.name, p]));

    // Merge: Cosmos locations are the source of truth for GPS coords;
    // enrich with full Photo object when available (provides URL, subject, etc.)
    const fromCosmos: GeoPin[] = cosmosLocations
      .flatMap((location) => {
        const gps = readGpsCoordinates(String(location.lat), String(location.lon));
        return gps
          ? [{
              name: location.name,
              lat: gps.lat,
              lon: gps.lon,
              originalName: location.originalName,
              contentType: location.contentType,
              photo: photoMap.get(location.name),
            }]
          : [];
      });

    // Also include photos with GPS that aren't in Cosmos yet (e.g. just uploaded this session)
    const cosmosNames = new Set(fromCosmos.map((location) => location.name));
    const fromPhotosOnly: GeoPin[] = currentPhotos
      .filter((p) => !cosmosNames.has(p.name))
      .flatMap((p) => {
        const gps = readGpsCoordinates(p.gpsLat, p.gpsLon);
        if (!gps) return [];
        return [{ name: p.name, lat: gps.lat, lon: gps.lon, originalName: p.originalName, contentType: p.contentType, photo: p } satisfies GeoPin];
      });

    return [...fromCosmos, ...fromPhotosOnly];
  }, [cosmosLocations, groupId, photos, photosGroupId]);

  const noGpsPhotos = useMemo(
    () => (photosGroupId === groupId ? photos : [])
      .filter((p) => !readGpsCoordinates(p.gpsLat, p.gpsLon)),
    [groupId, photos, photosGroupId],
  );

  // Includes coordinates so effect re-runs on GPS updates, not just count changes
  const geoPhotoKey = useMemo(
    () => geoPhotos
      .map((p) => `${p.name}@${p.lat.toFixed(5)},${p.lon.toFixed(5)}#${displayName(p)}`)
      .join("|"),
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
    const restoreSavedPhotoFocus = (name: string, element: HTMLElement) => {
      const pending = pendingMarkerFocusRef.current;
      if (!pending || pending.name !== name) return;
      pendingMarkerFocusRef.current = null;
      if (pending.expiresAt < Date.now() || !element.isConnected) return;
      editRestoreFocusRef.current = element;
      element.focus({ preventScroll: true });
    };

    // Remove stale markers
    for (const [name, registration] of markerMap) {
      if (!currentNames.has(name)) {
        removeMarkerRegistration(registration);
        markerMap.delete(name);
      }
    }

    // Add new / update moved markers
    let addedNew = false;
    for (const p of geoPhotos) {
      let existing = markerMap.get(p.name);
      if (existing && existing.workspace !== groupId) {
        removeMarkerRegistration(existing);
        markerMap.delete(p.name);
        existing = undefined;
      }
      if (existing) {
        const pos = existing.marker.getLatLng();
        if (Math.abs(pos.lat - p.lat) > 0.00001 || Math.abs(pos.lng - p.lon) > 0.00001) {
          existing.marker.setLatLng([p.lat, p.lon]);
        }
        const label = getMapMarkerLabel(p);
        existing.element.setAttribute("aria-label", label);
        existing.element.setAttribute("title", label);
        existing.marker.setTooltipContent(createMapTooltipContent(p));
        restoreSavedPhotoFocus(p.name, existing.element);
      } else {
        // Lightweight dot - no photo URL in icon = no extra network requests
        const label = getMapMarkerLabel(p);
        const icon = L.divIcon({
          className: "map-photo-marker",
          html: `<div class="map-marker-pin"></div>`,
          iconSize: [44, 44],
          iconAnchor: [22, 22],
          tooltipAnchor: [0, -22],
        });
        const marker = L.marker([p.lat, p.lon], {
          icon,
          keyboard: false,
          autoPanOnFocus: true,
          title: label,
        })
          .bindTooltip(createMapTooltipContent(p), { direction: "top" })
          .addTo(map);
        const element = marker.getElement();
        if (!element) {
          marker.remove();
          continue;
        }
        element.setAttribute("tabindex", "0");
        element.setAttribute("role", "button");
        element.setAttribute("aria-label", getMapMarkerLabel(p));
        element.setAttribute("title", label);
        const activate = () => {
          if (!element.isConnected) return;
          element.focus({ preventScroll: true });
          detailRestoreFocusRef.current = element;
          setSelectedTarget({ workspace: groupId, name: p.name });
        };
        const keydown = (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) activate();
        };
        element.addEventListener("keydown", keydown);
        marker.on("click", activate);
        markerMap.set(p.name, { marker, element, click: activate, keydown, workspace: groupId });
        restoreSavedPhotoFocus(p.name, element);
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
  }, [geoPhotoKey, groupId, mapReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      editSessionRef.current += 1;
      pendingMarkerFocusRef.current = null;
      for (const registration of markerMapRef.current.values()) {
        removeMarkerRegistration(registration);
      }
      markerMapRef.current.clear();
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
      }
    };
  }, []);

  // Always resolves to the latest pin data, but never across workspace changes.
  const selected = useMemo(
    () => (
      selectedTarget?.workspace === groupId
        ? geoPhotos.find((p) => p.name === selectedTarget.name) ?? null
        : null
    ),
    [geoPhotos, groupId, selectedTarget],
  );
  const editPhoto = editTarget?.workspace === groupId ? editTarget.photo : null;

  const closeDetail = () => setSelectedTarget(null);

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

  const openEditFor = (photo: Photo, restoreTarget: HTMLElement | null) => {
    editSessionRef.current += 1;
    editRestoreFocusRef.current = restoreTarget;
    setEditTarget({ workspace: groupId, photo });
    setShowLocationSearch(false);
    setManualLat(photo.gpsLat ?? "");
    setManualLon(photo.gpsLon ?? "");
  };

  const resetEdit = () => {
    editSessionRef.current += 1;
    setEditTarget(null);
    setShowLocationSearch(false);
    setManualLat("");
    setManualLon("");
  };

  const closeEdit = () => {
    if (saving) return;
    resetEdit();
  };

  const saveGps = async (lat: string, lon: string) => {
    const gps = readGpsCoordinates(lat, lon);
    if (!editTarget || editTarget.workspace !== workspaceRef.current || !gps) {
      showToast("请输入有效的纬度（-90 到 90）和经度（-180 到 180）", "error");
      return;
    }
    const session = editSessionRef.current;
    const target = editTarget;
    const normalizedLat = String(gps.lat);
    const normalizedLon = String(gps.lon);
    setSaving(true);
    try {
      await updatePhotoGps(target.photo.name, normalizedLat, normalizedLon);
      if (
        !mountedRef.current
        || session !== editSessionRef.current
        || target.workspace !== workspaceRef.current
      ) return;
      const existingMarker = markerMapRef.current.get(target.photo.name)?.element;
      if (existingMarker?.isConnected) {
        editRestoreFocusRef.current = existingMarker;
      } else if (editRestoreFocusRef.current?.matches(".memory-map-nogps-item")) {
        pendingMarkerFocusRef.current = {
          name: target.photo.name,
          expiresAt: Date.now() + 1_000,
        };
      }
      onGpsUpdate?.(target.photo.name, normalizedLat, normalizedLon);
      setSaving(false);
      resetEdit();
    } catch (error) {
      if (
        mountedRef.current
        && session === editSessionRef.current
        && target.workspace === workspaceRef.current
      ) {
        showToast(error instanceof Error ? error.message : "更新照片位置失败", "error");
      }
    } finally {
      if (mountedRef.current && session === editSessionRef.current) setSaving(false);
    }
  };

  const canSaveManual = readGpsCoordinates(manualLat, manualLon) !== null;

  useEffect(() => {
    setSelectedTarget(null);
    editSessionRef.current += 1;
    setEditTarget(null);
    setShowLocationSearch(false);
    setManualLat("");
    setManualLon("");
    setSaving(false);
    pendingMarkerFocusRef.current = null;
  }, [groupId]);

  useModalFocusBoundary({
    active: selected !== null,
    layerRef: detailLayerRef,
    containerRef: detailDialogRef,
    initialFocusRef: detailCloseRef,
    restoreFocusRef: detailRestoreFocusRef,
    onEscape: () => {
      closeDetail();
      return true;
    },
  });

  useModalFocusBoundary({
    active: editPhoto !== null,
    layerRef: editLayerRef,
    containerRef: editDialogRef,
    initialFocusRef: manualLatRef,
    restoreFocusRef: editRestoreFocusRef,
    onEscape: () => {
      if (saving) return false;
      resetEdit();
      return true;
    },
  });

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
                    onClick={(event) => openEditFor(p, event.currentTarget)}
                    title={displayName(p)}
                    aria-label={`为照片 ${displayName(p)} 设置位置`}
                  >
                    <MediaThumb blobName={p.name} url={p.url} thumbnailUrl={p.thumbnailUrl} previewUrl={p.previewUrl} contentType={p.contentType} alt="" className="memory-map-nogps-thumb" />
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

      {selected && createPortal(
        <div ref={detailLayerRef} className="memory-map-detail" data-modal-layer onClick={closeDetail}>
          <div
            ref={detailDialogRef}
            className="memory-map-detail-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="memory-map-detail-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <button ref={detailCloseRef} type="button" className="memory-map-detail-close" onClick={closeDetail} aria-label="关闭照片位置详情">✕</button>
            {selected.photo ? (
              <MediaThumb
                blobName={selected.photo.name}
                url={selected.photo.url}
                thumbnailUrl={selected.photo.thumbnailUrl}
                previewUrl={selected.photo.previewUrl}
                alt={displayName(selected)}
                contentType={selected.photo.contentType}
                className="memory-map-detail-img"
                loading="lazy"
              />
            ) : (
              <div className="memory-map-detail-img memory-map-detail-img--placeholder">📷</div>
            )}
            <div className="memory-map-detail-info">
              <div id="memory-map-detail-title" className="memory-map-detail-name">{displayName(selected)}</div>
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
                    onClick={() => { closeDetail(); onViewPhoto(selected.name); }}
                  >在时间线中查看</button>
                )}
                {selected.photo && (
                  <button
                    className="memory-map-detail-edit"
                    onClick={() => {
                      const markerElement = markerMapRef.current.get(selected.name)?.element ?? null;
                      closeDetail();
                      openEditFor(selected.photo!, markerElement);
                    }}
                  >✏️ 修改位置</button>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {editPhoto && createPortal(
        <div ref={editLayerRef} className="map-gps-overlay" data-modal-layer onClick={closeEdit}>
          <div
            ref={editDialogRef}
            className="map-gps-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="map-gps-title"
            aria-describedby="map-gps-description"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="map-gps-header">
              <span id="map-gps-title">📍 设置位置</span>
              <button type="button" className="map-gps-close" onClick={closeEdit} aria-label="关闭位置设置">✕</button>
            </div>

            <div id="map-gps-description" className="map-gps-photo-row">
              <MediaThumb blobName={editPhoto.name} url={editPhoto.url} thumbnailUrl={editPhoto.thumbnailUrl} previewUrl={editPhoto.previewUrl} contentType={editPhoto.contentType} alt="" className="map-gps-photo-thumb" />
              <span className="map-gps-photo-name">{displayName(editPhoto)}</span>
            </div>

            {/* Shared LocationSearchPanel — same component + search logic as PhotoGallery/FolderView */}
            <div className="map-gps-section-label">
              搜索地址
              {!showLocationSearch && (
                <button ref={searchToggleRef} className="map-gps-search-toggle" onClick={() => setShowLocationSearch(true)}>
                  搜索 →
                </button>
              )}
            </div>
            {showLocationSearch && (
              <LocationSearchPanel
                saving={saving}
                onSelect={(lat, lon) => void saveGps(lat, lon)}
                onClose={() => setShowLocationSearch(false)}
                returnFocusRef={searchToggleRef}
                requestScope={groupId ?? "personal"}
              />
            )}

            <div className="map-gps-divider">或手动输入坐标</div>
            <div className="map-gps-manual-row">
              <label className="map-gps-coord-label">
                <span>纬度</span>
                <input
                  ref={manualLatRef}
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
