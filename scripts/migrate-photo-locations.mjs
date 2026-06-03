/**
 * scripts/migrate-photo-locations.mjs
 *
 * Migration: scans all image blobs, extracts EXIF GPS from the actual image bytes
 * (not just metadata), backfills gpsLat/gpsLon into blob metadata, and upserts
 * into the Cosmos DB `photoLocations` container.
 *
 * Skips videos, audio, blobs that already have GPS metadata, and soft-deleted blobs.
 *
 * Prerequisites:
 *   $env:COSMOS_ENDPOINT = 'https://cloud-photo-nosql-db.documents.azure.com:443/'
 *   $env:AZURE_STORAGE_ACCOUNT_NAME = '<your-storage-account>'
 *   Logged in via `az login` (DefaultAzureCredential)
 *
 * Usage:
 *   node scripts/migrate-photo-locations.mjs [--dry-run]
 */

import { BlobServiceClient } from "@azure/storage-blob";
import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import exifr from "exifr";

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const STORAGE_ACCOUNT = process.env.STORAGE_ACCOUNT_NAME ?? process.env.AZURE_STORAGE_ACCOUNT_NAME;
const CONTAINER_NAME = process.env.STORAGE_CONTAINER_NAME ?? "photos";
const DATABASE_ID = process.env.COSMOS_DATABASE ?? "cloudphoto";
const LOCATIONS_CONTAINER = "photoLocations";

const isDryRun = process.argv.includes("--dry-run");

if (!COSMOS_ENDPOINT) { console.error("❌  COSMOS_ENDPOINT env var is required."); process.exit(1); }
if (!STORAGE_ACCOUNT) { console.error("❌  STORAGE_ACCOUNT_NAME env var is required."); process.exit(1); }

const credential = new DefaultAzureCredential();
const cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: credential });
const db = cosmosClient.database(DATABASE_ID);
const locsContainer = db.container(LOCATIONS_CONTAINER);

const blobServiceClient = new BlobServiceClient(
  `https://${STORAGE_ACCOUNT}.blob.core.windows.net`, credential
);
const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);

const IMAGE_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp",
  "image/heic", "image/heif", "image/tiff",
]);

function decodeMeta(raw) {
  if (!raw) return undefined;
  try { return Buffer.from(raw, "base64").toString("utf8") || undefined; } catch { return raw || undefined; }
}
function getMeta(metadata, key) {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

async function downloadBlob(blobClient) {
  const downloadResponse = await blobClient.download();
  const chunks = [];
  for await (const chunk of downloadResponse.readableStreamBody) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  console.log(`${isDryRun ? "[DRY RUN] " : ""}Scanning blobs for EXIF GPS…\n`);

  let scanned = 0, skipped = 0, alreadyHasGps = 0, exifFound = 0, upserted = 0, errors = 0;

  for await (const blob of containerClient.listBlobsFlat({ includeMetadata: true })) {
    scanned++;
    const meta = blob.metadata ?? {};
    const contentType = (blob.properties.contentType ?? "").toLowerCase();

    // Skip soft-deleted, non-images, and voice memos
    if (getMeta(meta, "deletedAt")) { skipped++; continue; }
    if (!IMAGE_TYPES.has(contentType)) { skipped++; continue; }
    const segs = blob.name.split("/");
    if (segs.length < 4) { skipped++; continue; }
    const folderPart = segs.slice(2, segs.length - 1).join("/");
    if (folderPart === "_voice") { skipped++; continue; }

    // Already has GPS metadata — just ensure Cosmos is also populated
    const existingLat = getMeta(meta, "gpsLat");
    const existingLon = getMeta(meta, "gpsLon");
    if (existingLat && existingLon) {
      alreadyHasGps++;
      const lat = parseFloat(existingLat), lon = parseFloat(existingLon);
      if (!isNaN(lat) && !isNaN(lon)) {
        const scope = segs.slice(0, 2).join("/");
        const doc = {
          id: blob.name, scope, name: blob.name, lat, lon,
          originalName: decodeMeta(getMeta(meta, "originalName")),
          contentType: blob.properties.contentType,
          uploadedAt: getMeta(meta, "createdAt") ?? blob.properties.lastModified?.toISOString() ?? new Date().toISOString(),
        };
        if (!isDryRun) {
          try { await locsContainer.items.upsert(doc); upserted++; } catch (e) { errors++; console.error(`  ❌  Cosmos upsert failed for ${blob.name}: ${e.message}`); }
        } else { console.log(`  [DRY RUN] Would upsert (already has GPS): ${blob.name}`); upserted++; }
      }
      continue;
    }

    // Download and extract EXIF GPS
    process.stdout.write(`  Checking EXIF: ${blob.name.split("/").pop()} … `);
    try {
      const blobClient = containerClient.getBlobClient(blob.name);
      const bytes = await downloadBlob(blobClient);
      const gps = await exifr.gps(bytes);

      if (!gps?.latitude || !gps?.longitude) {
        process.stdout.write("no GPS\n");
        continue;
      }

      const lat = gps.latitude, lon = gps.longitude;
      process.stdout.write(`GPS: ${lat.toFixed(4)}, ${lon.toFixed(4)}\n`);
      exifFound++;

      if (isDryRun) {
        console.log(`    [DRY RUN] Would update blob metadata + upsert Cosmos for: ${blob.name}`);
        upserted++;
        continue;
      }

      // Write GPS back to blob metadata (must re-send ALL existing metadata)
      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      await blockBlobClient.setMetadata({ ...meta, gpsLat: String(lat), gpsLon: String(lon) });

      // Upsert to Cosmos
      const scope = segs.slice(0, 2).join("/");
      await locsContainer.items.upsert({
        id: blob.name, scope, name: blob.name, lat, lon,
        originalName: decodeMeta(getMeta(meta, "originalName")),
        contentType: blob.properties.contentType,
        uploadedAt: getMeta(meta, "createdAt") ?? blob.properties.lastModified?.toISOString() ?? new Date().toISOString(),
      });
      upserted++;
    } catch (e) {
      errors++;
      console.error(`\n  ❌  Error processing ${blob.name}: ${e.message}`);
    }

    if (upserted > 0 && upserted % 10 === 0) console.log(`  ✅ ${upserted} locations upserted so far…`);
  }

  console.log(`\nMigration complete:`);
  console.log(`  Blobs scanned       : ${scanned}`);
  console.log(`  Skipped (non-image) : ${skipped}`);
  console.log(`  Already had GPS     : ${alreadyHasGps}`);
  console.log(`  EXIF GPS found      : ${exifFound}`);
  console.log(`  Cosmos upserted     : ${upserted}`);
  console.log(`  Errors              : ${errors}`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

