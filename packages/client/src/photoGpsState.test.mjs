import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { partitionPhotoLocations } from "./components/memory-map/memoryMapLocationPartitions.ts";
import { applyAuthoritativeGpsUpdate } from "./photoGpsState.ts";

test("both successful GPS save surfaces apply authoritative provenance", async () => {
  const app = await readFile(new URL("./AuthenticatedApp.tsx", import.meta.url), "utf8");
  const calls = app.match(/applyAuthoritativeGpsUpdate\(/g) ?? [];

  assert.match(app, /import \{ applyAuthoritativeGpsUpdate \} from "\.\/photoGpsState"/);
  assert.equal(calls.length, 2);
});

test("adding GPS keeps a historical photo located in the current session", () => {
  const photos = [{
    name: "historical.jpg",
    gpsMetadataPresent: false,
  }];

  const updated = applyAuthoritativeGpsUpdate(
    photos,
    "historical.jpg",
    "31.2304",
    "121.4737",
  );
  const result = partitionPhotoLocations(updated, []);

  assert.equal(updated[0].gpsMetadataPresent, true);
  assert.deepEqual(result.geoPhotos.map(({ name, lat, lon }) => ({ name, lat, lon })), [{
    name: "historical.jpg",
    lat: 31.2304,
    lon: 121.4737,
  }]);
  assert.deepEqual(result.noGpsPhotos, []);
});

test("editing GPS keeps the current saved coordinates while the location index refreshes", () => {
  const photos = [{
    name: "historical.jpg",
    blobEtag: '"current"',
    gpsMetadataPresent: false,
    gpsLat: "31.2304",
    gpsLon: "121.4737",
  }];

  const updated = applyAuthoritativeGpsUpdate(
    photos,
    "historical.jpg",
    "30.2741",
    "120.1551",
  );
  const result = partitionPhotoLocations(updated, [{
    name: "historical.jpg",
    lat: 31.2304,
    lon: 121.4737,
    sourceBlobEtag: '"current"',
  }]);

  assert.equal(updated[0].gpsMetadataPresent, true);
  assert.deepEqual(result.geoPhotos.map(({ name, lat, lon }) => ({ name, lat, lon })), [{
    name: "historical.jpg",
    lat: 30.2741,
    lon: 120.1551,
  }]);
  assert.deepEqual(result.noGpsPhotos, []);
  assert.equal(result.diagnostics.staleCosmosIntersections, 1);
});
