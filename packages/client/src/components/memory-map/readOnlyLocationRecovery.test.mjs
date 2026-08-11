import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyReadOnlyLocationRecovery } from "./readOnlyLocationRecovery.ts";
import { partitionPhotoLocations } from "./memoryMapLocationPartitions.ts";

test("current-Blob read-only recovery makes a no-row historical photo authoritative", () => {
  const photo = {
    name: "personal/user/_/historical.jpg",
    blobEtag: '"current"',
    gpsMetadataPresent: false,
  };
  const recovered = applyReadOnlyLocationRecovery([photo], [{
    name: photo.name,
    gpsLat: "31.2304",
    gpsLon: "121.4737",
    sourceBlobEtag: '"current"',
  }]);
  const partition = partitionPhotoLocations(recovered, []);

  assert.equal(recovered[0].gpsMetadataPresent, true);
  assert.deepEqual(
    partition.geoPhotos.map(({ name, lat, lon }) => ({ name, lat, lon })),
    [{ name: photo.name, lat: 31.2304, lon: 121.4737 }],
  );
  assert.deepEqual(partition.noGpsPhotos, []);
});

test("current Blob recovery wins after stale, duplicate, or scope-invalid Cosmos rows are rejected", () => {
  const photos = [
    {
      name: "personal/user/_/stale.jpg",
      blobEtag: '"current"',
      gpsMetadataPresent: false,
    },
    {
      name: "personal/user/_/duplicate.jpg",
      blobEtag: '"current"',
      gpsMetadataPresent: false,
    },
    {
      name: "personal/user/_/scope.jpg",
      blobEtag: '"current"',
      gpsMetadataPresent: false,
    },
  ];
  const recovered = applyReadOnlyLocationRecovery(
    photos,
    photos.map((photo) => ({
      name: photo.name,
      gpsLat: "31.2304",
      gpsLon: "121.4737",
      sourceBlobEtag: '"current"',
    })),
  );
  const partition = partitionPhotoLocations(recovered, [
    {
      name: photos[0].name,
      lat: 1,
      lon: 2,
      sourceBlobEtag: '"stale"',
    },
    { name: photos[1].name, lat: 1, lon: 2 },
    { photoName: photos[1].name, lat: 1, lon: 2 },
    {
      scope: "personal/other",
      photoName: photos[2].name,
      lat: 1,
      lon: 2,
    },
  ]);

  assert.deepEqual(
    partition.geoPhotos.map(({ name }) => name),
    photos.map(({ name }) => name),
  );
  assert.deepEqual(partition.noGpsPhotos, []);
});

test("stale or malformed recovery results cannot alter current photo provenance", () => {
  const photos = [{
    name: "personal/user/_/photo.jpg",
    blobEtag: '"current"',
    gpsMetadataPresent: false,
  }];
  const recovered = applyReadOnlyLocationRecovery(photos, [
    {
      name: photos[0].name,
      gpsLat: "31.2304",
      gpsLon: "121.4737",
      sourceBlobEtag: '"stale"',
    },
    {
      name: "personal/user/_/orphan.jpg",
      gpsLat: "31.2304",
      gpsLon: "121.4737",
      sourceBlobEtag: '"current"',
    },
  ]);

  assert.deepEqual(recovered, photos);
});

test("a late recovery result cannot overwrite newly authoritative GPS", () => {
  const photos = [{
    name: "personal/user/_/saved.jpg",
    blobEtag: '"current"',
    gpsMetadataPresent: true,
    gpsLat: "10",
    gpsLon: "20",
  }];
  const recovered = applyReadOnlyLocationRecovery(photos, [{
    name: photos[0].name,
    gpsLat: "31.2304",
    gpsLon: "121.4737",
    sourceBlobEtag: '"current"',
  }]);

  assert.deepEqual(recovered, photos);
});

test("MemoryMap batches only proven-missing current photos through the read-only endpoint", async () => {
  const memoryMap = await readFile(
    new URL("./MemoryMap.tsx", import.meta.url),
    "utf8",
  );
  const photoApi = await readFile(
    new URL("../../services/photoApi.ts", import.meta.url),
    "utf8",
  );

  assert.match(memoryMap, /photo\.gpsMetadataPresent === false/);
  assert.match(memoryMap, /typeof photo\.blobEtag === "string"/);
  assert.match(memoryMap, /recoverReadOnlyPhotoLocations\(candidates, groupId/);
  assert.match(memoryMap, /applyReadOnlyLocationRecovery\(currentPhotos, recoveredLocations\)/);
  assert.match(memoryMap, /remainingCapacity = 512 - attempts\.total/);
  assert.match(memoryMap, /attempts\.requests >= 64/);
  assert.match(
    memoryMap,
    /attempts\.bytesRead \+ requestByteReservation > 128 \* 1024 \* 1024/,
  );
  assert.match(memoryMap, /attempts\.bytesRead \+= requestByteReservation/);
  assert.match(memoryMap, /attempts\.total \+= candidates\.length/);
  assert.doesNotMatch(memoryMap, /attempts\.total \+= processed\.length/);
  assert.match(memoryMap, /setRecoveryBatchRevision\(\(revision\) => revision \+ 1\)/);
  assert.match(
    memoryMap,
    /\[cosmosLocationsLoaded, groupId, noGpsPhotos, recoveryBatchRevision\]/,
  );
  assert.doesNotMatch(
    memoryMap,
    /attempts\.keys\.delete/,
    "dispatched candidates must remain single-attempt for the map session",
  );
  const cosmosRefreshEffect = memoryMap.slice(
    memoryMap.indexOf("// Fetch GPS locations from Cosmos"),
    memoryMap.indexOf("// Manual GPS editing"),
  );
  assert.doesNotMatch(cosmosRefreshEffect, /recoveryAttemptRef\.current\s*=/);
  assert.doesNotMatch(cosmosRefreshEffect, /setReadOnlyRecoveryState/);
  assert.match(photoApi, /method: "POST"/);
  assert.match(photoApi, /photos\/locations\/recover/);
  const recoveryFunction = photoApi.slice(
    photoApi.indexOf("export async function recoverReadOnlyPhotoLocations"),
    photoApi.indexOf("// ── Photo metadata mutations"),
  );
  assert.equal(
    (recoveryFunction.match(/generation !== getAuthGeneration\(\)/g) ?? []).length,
    2,
    "authorization must be rechecked after headers and after JSON parsing",
  );
});
