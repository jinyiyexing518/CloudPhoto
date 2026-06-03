/**
 * scripts/migrate-photo-locations.mjs
 *
 * One-time migration: scans all blobs in Azure Blob Storage and backfills
 * GPS-tagged photos into the Cosmos DB `photoLocations` container.
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

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const CONTAINER_NAME = "photos";
const DATABASE_ID = process.env.COSMOS_DATABASE ?? "cloudphoto";
const LOCATIONS_CONTAINER = "photoLocations";

const isDryRun = process.argv.includes("--dry-run");

if (!COSMOS_ENDPOINT) {
  console.error("❌  COSMOS_ENDPOINT env var is required.");
  process.exit(1);
}
if (!STORAGE_ACCOUNT) {
  console.error("❌  AZURE_STORAGE_ACCOUNT_NAME env var is required.");
  process.exit(1);
}

const credential = new DefaultAzureCredential();

// Cosmos client
const cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, aadCredentials: credential });
const db = cosmosClient.database(DATABASE_ID);
const locsContainer = db.container(LOCATIONS_CONTAINER);

// Blob client
const blobServiceUrl = `https://${STORAGE_ACCOUNT}.blob.core.windows.net`;
const blobServiceClient = new BlobServiceClient(blobServiceUrl, credential);
const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);

function decodeMeta(raw) {
  if (!raw) return undefined;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return decoded || undefined;
  } catch {
    return raw || undefined;
  }
}

function getMeta(metadata, key) {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

async function main() {
  console.log(`${isDryRun ? "[DRY RUN] " : ""}Scanning blobs for GPS metadata…`);

  let scanned = 0;
  let found = 0;
  let upserted = 0;
  let errors = 0;

  for await (const blob of containerClient.listBlobsFlat({ includeMetadata: true })) {
    scanned++;
    const meta = blob.metadata ?? {};

    // Skip soft-deleted blobs
    if (getMeta(meta, "deletedAt")) continue;

    const gpsLat = getMeta(meta, "gpsLat");
    const gpsLon = getMeta(meta, "gpsLon");
    if (!gpsLat || !gpsLon) continue;

    const lat = parseFloat(gpsLat);
    const lon = parseFloat(gpsLon);
    if (isNaN(lat) || isNaN(lon)) continue;

    found++;
    const blobName = blob.name;
    const segs = blobName.split("/");
    if (segs.length < 4) continue; // unexpected path format

    const scope = segs.slice(0, 2).join("/"); // "personal/{userId}" or "groups/{groupId}"
    const originalName = decodeMeta(getMeta(meta, "originalName"));
    const contentType = blob.properties.contentType;
    const uploadedAt = getMeta(meta, "createdAt") ?? blob.properties.createdOn?.toISOString() ?? new Date().toISOString();

    const doc = {
      id: blobName,
      scope,
      name: blobName,
      lat,
      lon,
      originalName,
      contentType,
      uploadedAt,
    };

    if (isDryRun) {
      console.log(`  [DRY RUN] Would upsert: ${blobName} → (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
      upserted++;
      continue;
    }

    try {
      await locsContainer.items.upsert(doc);
      upserted++;
      if (upserted % 10 === 0) console.log(`  ✅ Upserted ${upserted} locations so far…`);
    } catch (e) {
      errors++;
      console.error(`  ❌  Failed to upsert ${blobName}:`, e.message ?? e);
    }
  }

  console.log(`\nMigration complete:`);
  console.log(`  Blobs scanned : ${scanned}`);
  console.log(`  GPS-tagged    : ${found}`);
  console.log(`  Upserted      : ${upserted}`);
  console.log(`  Errors        : ${errors}`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
