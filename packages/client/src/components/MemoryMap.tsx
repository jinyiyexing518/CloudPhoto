import { useEffect, useRef, useState } from "react";
import type { Map, Marker } from "leaflet";
import { Photo } from "../services/photoApi";

interface Props {
  photos: Photo[];
  onViewPhoto?: (name: string) => void;
}

interface GeoPhoto extends Photo {
  lat: number;
  lon: number;
}

export default function MemoryMap({ photos, onViewPhoto }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<Map | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const [geoCount, setGeoCount] = useState(0);
  const [selected, setSelected] = useState<GeoPhoto | null>(null);

  const geoPhotos: GeoPhoto[] = photos
    .filter((p) => p.gpsLat && p.gpsLon)
    .map((p) => ({ ...p, lat: parseFloat(p.gpsLat!), lon: parseFloat(p.gpsLon!) }))
    .filter((p) => !isNaN(p.lat) && !isNaN(p.lon));

  useEffect(() => {
    setGeoCount(geoPhotos.length);
  }, [geoPhotos.length]);

  useEffect(() => {
    if (!mapRef.current) return;

    // Dynamically import Leaflet to avoid SSR issues
    import("leaflet").then((L) => {
      if (leafletMap.current) {
        leafletMap.current.remove();
        leafletMap.current = null;
      }

      const map = L.map(mapRef.current!, {
        center: geoPhotos.length > 0
          ? [geoPhotos[0].lat, geoPhotos[0].lon]
          : [20, 0],
        zoom: geoPhotos.length > 0 ? 5 : 2,
      });
      leafletMap.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(map);

      // Clear old markers
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      // Add photo markers
      geoPhotos.forEach((p) => {
        const icon = L.divIcon({
          className: "map-photo-marker",
          html: `<img src="${p.url}" alt="" />`,
          iconSize: [48, 48],
          iconAnchor: [24, 24],
        });
        const marker = L.marker([p.lat, p.lon], { icon }).addTo(map);
        marker.on("click", () => {
          setSelected(p);
        });
        markersRef.current.push(marker);
      });

      // Auto-fit bounds
      if (geoPhotos.length > 1) {
        const bounds = L.latLngBounds(geoPhotos.map((p) => [p.lat, p.lon]));
        map.fitBounds(bounds, { padding: [40, 40] });
      }
    });

    return () => {
      if (leafletMap.current) {
        leafletMap.current.remove();
        leafletMap.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-add markers when geoPhotos change (new uploads)
  useEffect(() => {
    if (!leafletMap.current) return;
    import("leaflet").then((L) => {
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
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoPhotos.length]);

  return (
    <div className="memory-map-wrap">
      {/* Leaflet CSS */}
      <link
        rel="stylesheet"
        href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      />

      <div className="memory-map-header">
        <span className="memory-map-title">🗺️ 记忆地图</span>
        <span className="memory-map-subtitle">
          {geoCount > 0
            ? `${geoCount} 张照片有位置信息`
            : "暂无位置信息——开启相机位置权限后上传的照片将在此显示"}
        </span>
      </div>

      <div ref={mapRef} className="memory-map-container" />

      {geoCount === 0 && (
        <div className="memory-map-empty">
          <div className="memory-map-empty-icon">📍</div>
          <p>上传含有 GPS 信息的照片后，拍摄地点将显示在地图上</p>
          <p className="memory-map-empty-hint">提示：使用手机相机并开启位置权限拍摄的照片通常含有 GPS 信息</p>
        </div>
      )}

      {selected && (
        <div className="memory-map-detail" onClick={() => setSelected(null)}>
          <div className="memory-map-detail-card" onClick={(e) => e.stopPropagation()}>
            <button className="memory-map-detail-close" onClick={() => setSelected(null)}>✕</button>
            <img src={selected.url} alt={selected.originalName ?? "照片"} className="memory-map-detail-img" />
            <div className="memory-map-detail-info">
              <div className="memory-map-detail-name">{selected.originalName ?? selected.name.split("/").pop()}</div>
              <div className="memory-map-detail-coords">
                📍 {selected.lat.toFixed(4)}, {selected.lon.toFixed(4)}
              </div>
              {selected.subject && <div className="memory-map-detail-subject">🏷 {selected.subject}</div>}
              <div className="memory-map-detail-date">
                🗓 {new Date(selected.createdAt ?? selected.lastModified ?? "").toLocaleDateString("zh-CN")}
              </div>
              {onViewPhoto && (
                <button
                  className="memory-map-detail-jump"
                  onClick={() => { setSelected(null); onViewPhoto(selected.name); }}
                >在时间线中查看</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
