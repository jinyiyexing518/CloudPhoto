import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("client EXIF coordinates flow into the upload query without dropping zero", async () => {
  const [app, uploadApi] = await Promise.all([
    source("packages/client/src/AuthenticatedApp.tsx"),
    source("packages/client/src/services/uploadApi.ts"),
  ]);
  assert.match(app, /exifrLib\.gps\((?:valid\[i\]|uploadFile)\)/);
  assert.match(app, /gpsLat = String\(gps\.latitude\)/);
  assert.match(app, /gpsLon = String\(gps\.longitude\)/);
  assert.match(app, /uploadPhotoWithProgress\([\s\S]*gpsLat,[\s\S]*gpsLon,/);
  assert.match(uploadApi, /gpsLat !== undefined && gpsLat\.trim\(\) !== ""/);
  assert.match(uploadApi, /params\.set\("gpsLat", gpsLat\)/);
  assert.match(uploadApi, /params\.set\("gpsLon", gpsLon\)/);
});

test("server fallback, Blob metadata, upload response, and refreshed list share the GPS contract", async () => {
  const [upload, list] = await Promise.all([
    source("packages/server/src/functions/photos/uploadPhoto.ts"),
    source("packages/server/src/functions/photos/listPhotos.ts"),
  ]);
  assert.match(upload, /resolveUploadGps\(gpsLat, gpsLon/);
  assert.match(upload, /exifr\.gps\(buf\)/);
  assert.match(upload, /\.\.\.uploadGpsMetadata\(resolvedGps\)/);
  assert.match(upload, /const gps = readGpsMetadata\(metadata\)/);
  assert.match(upload, /\.\.\.\(gps \?\? \{\}\)/);
  assert.match(list, /const gps = readGpsMetadata\(blob\.metadata\)/);
  assert.match(list, /gpsLat: gps\?\.gpsLat/);
  assert.match(list, /gpsLon: gps\?\.gpsLon/);
});

test("personal and group authorization failures return before Blob fallback work", async () => {
  const upload = await source("packages/server/src/functions/photos/uploadPhoto.ts");
  const authIndex = upload.indexOf("extractTokenFromHeader");
  const membershipIndex = upload.indexOf("isGroupMember(groupId, payload.userId)");
  const blobIndex = upload.indexOf("getBlobServiceClient()");
  const exifIndex = upload.indexOf("exifr.gps(buf)");
  assert.ok(authIndex >= 0 && membershipIndex > authIndex);
  assert.ok(blobIndex > membershipIndex);
  assert.ok(exifIndex > blobIndex);
});

test("maintenance skips videos and deleted blobs before bounded EXIF reads", async () => {
  const backfill = await source("packages/server/src/functions/photos/backfillPhotoMetadata.ts");
  assert.match(backfill, /isDeleted[\s\S]*!isRecoverableImageMime\(contentType\)/);
  assert.match(backfill, /syncLocation: \(signal\) => syncPhotoLocationFromBlob/);
  assert.ok(
    backfill.indexOf("isDeleted") < backfill.indexOf("downloadToBuffer("),
    "excluded states must branch before bounded original reads",
  );
});

test("maintenance records a bumped GPS scan marker without rescanning valid pairs", async () => {
  const recovery = await source("packages/server/src/functions/photos/photoMetadataRecovery.ts");
  assert.match(recovery, /GPS_SCAN_VERSION = "2"/);
  assert.match(recovery, /existingGps === null/);
  assert.match(recovery, /gpsScanVersion"\) !== GPS_SCAN_VERSION/);
  assert.match(recovery, /setMetadataValue\(latestMetadata, "gpsScanVersion", GPS_SCAN_VERSION\)/);
});

test("maintenance uses bounded conditional ranges and the same source ETag for its only write", async () => {
  const backfill = await source("packages/server/src/functions/photos/backfillPhotoMetadata.ts");
  const download = backfill.indexOf("downloadToBuffer(");
  const conditionalRead = backfill.indexOf("conditions: { ifMatch: etag }", download);
  const conditionalWrite = backfill.indexOf("conditions: { ifMatch: sourceEtag }", conditionalRead);
  assert.ok(download >= 0 && conditionalRead > download && conditionalWrite > conditionalRead);
  assert.doesNotMatch(backfill, /downloadToBuffer\(\s*\)/);
});

test("the GPS-pending upload warning is only returned when valid GPS exists", async () => {
  const upload = await source("packages/server/src/functions/photos/uploadPhoto.ts");
  const gpsRead = upload.indexOf("const gps = readGpsMetadata(metadata)");
  const sync = upload.indexOf("await syncPhotoLocationFromBlob", gpsRead);
  const pending = upload.indexOf("locationIndexPending = Boolean(gps)", sync);
  assert.ok(gpsRead >= 0 && sync > gpsRead && pending > sync);
});

test("transactional folder rename republishes new location ids and removes old Cosmos ids", async () => {
  const rename = await source("packages/server/src/functions/photos/renameFolder.ts");
  assert.match(rename, /syncLocation\(container\.getBlockBlobClient\(newName\), newName, scope, controller\.signal\)/);
  assert.match(rename, /syncLocation\(container\.getBlockBlobClient\(oldName\), oldName, scope, controller\.signal\)/);
  assert.match(rename, /requestTimeoutMs: Math\.min\(/);
  assert.match(rename, /reconcileTimeoutMs/);
  assert.match(rename, /locationIndexPending = locationReconciliation\.pending > 0/);
  assert.match(rename, /locationIndexInventoryIncomplete/);
});
