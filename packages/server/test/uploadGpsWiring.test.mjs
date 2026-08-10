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
  assert.match(list, /gpsLat: getMeta\(blob\.metadata, "gpsLat"\)/);
  assert.match(list, /gpsLon: getMeta\(blob\.metadata, "gpsLon"\)/);
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

test("maintenance reconciles videos, deleted blobs, and images with no new EXIF without downloading them", async () => {
  const backfill = await source("packages/server/src/functions/photos/backfillPhotoMetadata.ts");
  assert.doesNotMatch(backfill, /if \(!ALLOWED_IMAGE_MIME\.has\(mime\)\) continue/);
  assert.match(backfill, /isDeleted \|\| !isImage \|\| \(!needsTakenAt && !needsGps\)/);
  assert.match(backfill, /sync: \(\) => syncPhotoLocationFromBlob\(blockBlobClient, blob\.name, scope\)/);
  assert.ok(
    backfill.indexOf("if (isDeleted || !isImage") < backfill.indexOf("downloadToBuffer()"),
    "reconciliation-only states must branch before original downloads",
  );
});

test("maintenance records a versioned scan so no-EXIF originals are not downloaded repeatedly", async () => {
  const backfill = await source("packages/server/src/functions/photos/backfillPhotoMetadata.ts");
  assert.match(backfill, /const METADATA_SCAN_VERSION = "1"/);
  assert.match(backfill, /!needsMetadataScan/);
  assert.match(backfill, /setMeta\(latestMetadata, "metadataScanVersion", METADATA_SCAN_VERSION\)/);
  assert.match(backfill, /conditions: \{ ifMatch: props\.etag \}/);
});

test("maintenance uses the pre-download source ETag and never retries stale EXIF onto a replaced blob", async () => {
  const backfill = await source("packages/server/src/functions/photos/backfillPhotoMetadata.ts");
  const sourceProperties = backfill.indexOf("const props = await blockBlobClient.getProperties()");
  const download = backfill.indexOf("const buf = await blockBlobClient.downloadToBuffer()", sourceProperties);
  const conditionalWrite = backfill.indexOf("conditions: { ifMatch: props.etag }", download);
  assert.ok(sourceProperties >= 0 && download > sourceProperties && conditionalWrite > download);
  assert.doesNotMatch(backfill, /isPreconditionFailed\(error\).*continue/s);
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
  assert.match(rename, /syncPhotoLocationFromBlob\(container\.getBlockBlobClient\(blob\.name\), blob\.name, scope\)/);
  assert.match(rename, /syncPhotoLocationFromBlob\(container\.getBlockBlobClient\(oldName\), oldName, scope\)/);
  assert.match(rename, /pendingLocationIndexes > 0/);
});
