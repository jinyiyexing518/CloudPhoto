#!/usr/bin/env node
/**
 * cleanup-cosmos-ids.mjs  (ONE-TIME — delete after use)
 *
 * Deletes the 3 orphaned date-prefixed changelog IDs from Cosmos DB
 * that were created before the id naming was standardised.
 *
 * Prerequisites:
 *   az login  (or COSMOS_ENDPOINT env var already set by CI)
 *
 * Usage:
 *   $env:COSMOS_ENDPOINT = "https://<account>.documents.azure.com:443/"
 *   node scripts/cleanup-cosmos-ids.mjs
 */

import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const endpoint = process.env.COSMOS_ENDPOINT;
if (!endpoint) {
  console.error("Error: COSMOS_ENDPOINT is not set.");
  process.exit(1);
}

const databaseId = process.env.COSMOS_DATABASE ?? "cloudphoto";
const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
const container = client.database(databaseId).container("changelogs");

const staleIds = [
  "2026-06-02-timeline-tremble-fix",
  "2026-06-02-memory-map-gps-fix",
  "2026-06-02-upload-pause-speed-retry",
];

console.log(`Deleting ${staleIds.length} stale items from "${databaseId}/changelogs" …`);

for (const id of staleIds) {
  try {
    await container.item(id, id).delete();
    console.log(`  ✓ deleted  ${id}`);
  } catch (e) {
    if (e.code === 404) {
      console.log(`  – not found (already gone): ${id}`);
    } else {
      console.error(`  ✗ failed   ${id}:`, e.message);
    }
  }
}

console.log("Done.");
