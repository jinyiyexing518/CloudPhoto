import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

test("memory map markers are named 44px buttons with one keyboard activation path", async () => {
  const [memoryMap, css] = await Promise.all([
    source("./MemoryMap.tsx"),
    source("../../authenticated.css"),
  ]);

  assert.match(memoryMap, /className:\s*"map-photo-marker"/);
  assert.match(memoryMap, /iconSize:\s*\[44,\s*44\]/);
  assert.match(memoryMap, /iconAnchor:\s*\[22,\s*22\]/);
  assert.match(memoryMap, /tooltipAnchor:\s*\[0,\s*-22\]/);
  assert.match(memoryMap, /keyboard:\s*false/);
  assert.match(memoryMap, /autoPanOnFocus:\s*true/);
  assert.match(memoryMap, /setAttribute\("role",\s*"button"\)/);
  assert.match(memoryMap, /setAttribute\("aria-label",\s*getMapMarkerLabel\(p\)\)/);
  assert.match(memoryMap, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(memoryMap, /removeEventListener\("keydown"/);
  assert.match(css, /\.map-photo-marker:focus-visible/);
  assert.match(css, /\.map-marker-pin\s*\{[\s\S]*width:\s*22px;[\s\S]*height:\s*22px;/);
});

test("map detail and GPS edit overlays use the shared modal boundary", async () => {
  const [memoryMap, boundary, locationSearch, css] = await Promise.all([
    source("./MemoryMap.tsx"),
    source("../shared/useModalFocusBoundary.ts"),
    source("../shared/LocationSearchPanel.tsx"),
    source("../../authenticated.css"),
  ]);

  assert.match(memoryMap, /useModalFocusBoundary\(\{[\s\S]*active:\s*selected !== null/);
  assert.match(memoryMap, /useModalFocusBoundary\(\{[\s\S]*active:\s*editPhoto !== null/);
  assert.match(memoryMap, /className="memory-map-detail"[\s\S]*data-modal-layer/);
  assert.match(memoryMap, /className="memory-map-detail-card"[\s\S]*role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="memory-map-detail-title"/);
  assert.match(memoryMap, /className="map-gps-overlay"[\s\S]*data-modal-layer/);
  assert.match(memoryMap, /className="map-gps-dialog"[\s\S]*role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="map-gps-title"[\s\S]*aria-describedby="map-gps-description"/);
  assert.match(memoryMap, /if \(saving\) return false;/);
  assert.match(boundary, /restoreFocusRef/);
  assert.match(boundary, /restoreFocus\(restoreFocusRef\?\.current \?\? previousFocusRef\.current\)/);
  assert.match(locationSearch, /<button[\s\S]*className="location-search-coord-preview"/);
  assert.match(locationSearch, /<li[\s\S]*<button[\s\S]*className="location-search-result"/);
  assert.doesNotMatch(locationSearch, /<(?:div|li)[^>]*className="location-search-(?:coord-preview|result)"/);
  assert.match(locationSearch, /className="location-search-panel" onKeyDown=\{handlePanelKeyDown\}/);
  assert.match(locationSearch, /e\.key === "Escape"[\s\S]*e\.stopPropagation\(\);[\s\S]*if \(saving\) return;[\s\S]*onClose\(\)[\s\S]*restoreTriggerFocus\(\)/);
  assert.match(locationSearch, /returnFocusRef\?\.current[\s\S]*target\?\.isConnected[\s\S]*target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(css, /\.location-search-result\s*\{[\s\S]*min-height:\s*44px/);
  assert.match(css, /\.location-search-coord-preview\s*\{[\s\S]*min-height:\s*44px/);
});

test("manual coordinates and no-GPS photo controls expose complete contracts", async () => {
  const memoryMap = await source("./MemoryMap.tsx");

  assert.match(memoryMap, /readGpsCoordinates\(manualLat,\s*manualLon\)/);
  assert.doesNotMatch(memoryMap, /!isNaN\(parseFloat\(manualLat\)\)/);
  assert.match(memoryMap, /aria-label=\{`为照片 \$\{displayName\(p\)\} 设置位置`\}/);
  assert.match(memoryMap, /alt=""/);
  assert.match(memoryMap, /ref=\{manualLatRef\}/);
  assert.match(memoryMap, /showToast\(error instanceof Error \? error\.message : "更新照片位置失败",\s*"error"\)/);
  assert.match(memoryMap, /workspaceRef\.current = groupId/);
  assert.match(memoryMap, /useEffect\(\(\) => \{[\s\S]*mountedRef\.current = true;[\s\S]*mountedRef\.current = false;[\s\S]*editSessionRef\.current \+= 1/);
  assert.match(memoryMap, /target\.workspace !== workspaceRef\.current/);
  assert.match(memoryMap, /pendingMarkerFocusRef\.current = \{[\s\S]*name: target\.photo\.name[\s\S]*expiresAt: Date\.now\(\) \+ 1_000/);
  assert.match(memoryMap, /existingMarker\?\.isConnected[\s\S]*editRestoreFocusRef\.current = existingMarker/);
  assert.match(memoryMap, /restoreSavedPhotoFocus\(p\.name, element\)/);
  assert.match(memoryMap, /editRestoreFocusRef\.current = element;[\s\S]*element\.focus\(\{ preventScroll: true \}\)/);
});

test("shared coordinate parser rejects partial and out-of-range manual values", async () => {
  const { readGpsCoordinates } = await import("../../utils/gpsCoordinates.ts");

  assert.deepEqual(readGpsCoordinates("90", "-180"), { lat: 90, lon: -180 });
  assert.deepEqual(readGpsCoordinates("-90.0", "180.0"), { lat: -90, lon: 180 });
  assert.deepEqual(readGpsCoordinates("39.9042", "116.4074"), { lat: 39.9042, lon: 116.4074 });
  for (const [lat, lon] of [
    ["91", "0"],
    ["0", "181"],
    ["39north", "116"],
    ["39", "116east"],
    ["", "116"],
    ["Infinity", "0"],
  ]) {
    assert.equal(readGpsCoordinates(lat, lon), null, `${lat}, ${lon} must be rejected`);
  }
});

test("marker labels expose only a stable photo display name", async () => {
  const {
    createMapTooltipContent,
    getMapMarkerLabel,
    getPhotoDisplayName,
  } = await import("./memoryMapAccessibility.ts");

  assert.equal(getMapMarkerLabel({ name: "users/chi/holiday.jpg" }), "查看照片位置：holiday.jpg");
  assert.equal(
    getMapMarkerLabel({ name: "ignored", originalName: "https://blob.example/photos/holiday%20photo.jpg?sig=secret" }),
    "查看照片位置：holiday photo.jpg",
  );
  assert.equal(getPhotoDisplayName({ name: "" }), "未命名照片");
  const tooltip = { textContent: null };
  const maliciousName = "%3Cimg%20src=x%20onerror=alert(1)%3E.jpg";
  assert.equal(
    createMapTooltipContent(
      { name: maliciousName },
      { createElement: () => tooltip },
    ),
    tooltip,
  );
  assert.equal(tooltip.textContent, "<img src=x onerror=alert(1)>.jpg");
});

test("Header install entry remains absent", async () => {
  const [app, css] = await Promise.all([
    source("../../AuthenticatedApp.tsx"),
    source("../../authenticated.css"),
  ]);
  assert.doesNotMatch(app, /header-install-button/);
  assert.doesNotMatch(css, /\.header-install-button/);
});
