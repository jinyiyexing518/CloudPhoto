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

test("an unavailable address still renders the current photo coordinates", async () => {
  const [timeline, folders] = await Promise.all([
    source("PhotoGallery.tsx"),
    source("FolderView.tsx"),
  ]);
  for (const surface of [timeline, folders]) {
    assert.match(surface, /geoAddress \?\? `\$\{parseFloat\(selectedPhoto\.gpsLat\)\.toFixed\(4\)\}°/);
  }
});

test("memory map renders Cosmos locations only for the workspace that produced them", async () => {
  const memoryMap = await source("../memory-map/MemoryMap.tsx");
  assert.match(memoryMap, /cosmosLocationState\.workspace === groupId/);
  assert.match(memoryMap, /photosGroupId === groupId \? photos : \[\]/);
  assert.match(memoryMap, /setCosmosLocationState\(\{ workspace, locations \}\)/);
  assert.match(memoryMap, /controller\.abort\(new DOMException\("Workspace changed", "AbortError"\)\)/);
});
