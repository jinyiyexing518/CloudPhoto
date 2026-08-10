import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(name) {
  return readFile(new URL(name, import.meta.url), "utf8");
}

test("both gallery surfaces share the abortable photo identity hook", async () => {
  const [timeline, folders, hook] = await Promise.all([
    source("PhotoGallery.tsx"),
    source("FolderView.tsx"),
    source("usePhotoLocationAddress.ts"),
  ]);
  for (const surface of [timeline, folders]) {
    assert.match(surface, /usePhotoLocationAddress\(selectedPhoto\)/);
    assert.doesNotMatch(surface, /reverseGeocode\(lat, lon\)\.then/);
  }
  assert.match(hook, /new AbortController\(\)/);
  assert.match(hook, /workspace: workspaceForPhoto\(photoName\)/);
  assert.match(hook, /controller\.signal\.aborted/);
  assert.match(hook, /const identity = `\$\{photoName\}:\$\{photo\?\.gpsLat/);
  assert.match(hook, /result\.identity === identity/);
});

test("address failures remain distinct from missing GPS without rendering coordinates", async () => {
  const [timeline, folders, hook, batchOperations] = await Promise.all([
    source("PhotoGallery.tsx"),
    source("FolderView.tsx"),
    source("usePhotoLocationAddress.ts"),
    source("../shared/BatchOperationsBar.tsx"),
  ]);
  for (const surface of [timeline, folders]) {
    assert.match(surface, /const selectedGps = readGpsCoordinates\(selectedPhoto\?\.gpsLat, selectedPhoto\?\.gpsLon\)/);
    assert.match(surface, /geoStatus === "unavailable"[\s\S]*\? "地址暂不可用"/);
    assert.doesNotMatch(surface, /geoAddress \?\? `\$\{selectedGps\.lat\.toFixed\(4\)\}°/);
    assert.match(surface, /\{selectedGps && \(/);
    assert.match(surface, /\{!selectedGps && \(/);
    assert.match(surface, /const session = \+\+gpsSaveSessionRef\.current;[\s\S]*await updatePhotoGps\(targetPhoto\.name, lat, lon\);[\s\S]*!mountedRef\.current \|\| session !== gpsSaveSessionRef\.current/);
    assert.match(surface, /const invalidateGpsSave = useCallback\(\(\) => \{[\s\S]*gpsSaveSessionRef\.current \+= 1;[\s\S]*setSavingGps\(false\)/);
    assert.match(surface, /setEditingGps\(false\);[\s\S]*gpsEditButtonRef\.current[\s\S]*target\?\.isConnected[\s\S]*target\.focus\(\{ preventScroll: true \}\)/);
  }
  assert.match(batchOperations, /onApplyBatchGps\(lat, lon\)\.then\(\(applied\)[\s\S]*if \(!applied\) return;[\s\S]*batchGpsButtonRef\.current[\s\S]*target\?\.isConnected[\s\S]*target\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(batchOperations, /showBatchGpsEdit[\s\S]{0,160}batchGpsButtonRef\.current/);
  assert.match(hook, /"missing-coordinates"/);
  assert.match(hook, /"unavailable"/);
});

test("memory map renders Cosmos locations only for the workspace that produced them", async () => {
  const [memoryMap, app] = await Promise.all([
    source("../memory-map/MemoryMap.tsx"),
    source("../../AuthenticatedApp.tsx"),
  ]);
  assert.match(memoryMap, /cosmosLocationState\.workspace === groupId/);
  assert.match(memoryMap, /photosGroupId === groupId \? photos : \[\]/);
  assert.match(memoryMap, /partitionPhotoLocations\(currentPhotos, cosmosLocations\)/);
  assert.match(memoryMap, /const \{ geoPhotos, noGpsPhotos \} = locationPartitions/);
  assert.match(memoryMap, /readGpsCoordinates\(manualLat, manualLon\) !== null/);
  assert.match(memoryMap, /showToast\(error instanceof Error \? error\.message/);
  assert.match(memoryMap, /setCosmosLocationState\(\{ workspace, locations \}\)/);
  assert.match(memoryMap, /controller\.abort\(new DOMException\("Workspace changed", "AbortError"\)\)/);
  assert.match(memoryMap, /locationIndexRevision/);
  assert.match(app, /activeTab === "map" && resolvedPhotoWorkspaceId !== null/);
  assert.match(app, /groupId=\{resolvedPhotoWorkspaceId\}/);
});
