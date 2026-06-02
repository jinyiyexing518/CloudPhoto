#!/usr/bin/env node
/**
 * sync-changelog.mjs
 *
 * Reads all files from changes/ and upserts them into the Cosmos DB
 * "changelogs" container.
 *
 * Prerequisites:
 *   - COSMOS_ENDPOINT env var set to your Cosmos DB account endpoint
 *     e.g. https://<account>.documents.azure.com:443/
 *   - COSMOS_DATABASE env var (optional, defaults to "cloudphoto")
 *   - Authenticated via one of:
 *       Local:          az login  (Azure CLI)
 *       GitHub Actions: azure/login@v2 with OIDC (WorkloadIdentity)
 *
 * Usage:
 *   node scripts/sync-changelog.mjs
 */

import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const endpoint = process.env.COSMOS_ENDPOINT;
if (!endpoint) {
  console.error("Error: COSMOS_ENDPOINT environment variable is not set.");
  console.error(
    "  Set it to your Cosmos DB account URL, e.g.:\n" +
      "  $env:COSMOS_ENDPOINT = 'https://<account>.documents.azure.com:443/'"
  );
  process.exit(1);
}

const databaseId = process.env.COSMOS_DATABASE ?? "cloudphoto";

const client = new CosmosClient({
  endpoint,
  aadCredentials: new DefaultAzureCredential(),
});

const container = client.database(databaseId).container("changelogs");

const changesDir = join(root, "changes");
const entries = readdirSync(changesDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .reverse()
  .map((f) => JSON.parse(readFileSync(join(changesDir, f), "utf8")));

if (entries.length === 0) {
  console.warn("No change files found in changes/. Nothing to sync.");
  process.exit(0);
}

console.log(
  `Syncing ${entries.length} changelog entries → Cosmos DB "${databaseId}/changelogs" ...`
);

for (const entry of entries) {
  await container.items.upsert(entry);
  console.log(`  ✓ ${entry.id} (${entry.date})`);
}

console.log("Done. All changelog entries are up to date.");
