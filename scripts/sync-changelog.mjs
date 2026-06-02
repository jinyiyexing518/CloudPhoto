#!/usr/bin/env node
/**
 * sync-changelog.mjs
 *
 * Reads data/changelog.json and upserts all entries into the Cosmos DB
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

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const changelogPath = join(__dirname, "..", "data", "changelog.json");
const entries = JSON.parse(readFileSync(changelogPath, "utf8"));

console.log(
  `Syncing ${entries.length} changelog entries → Cosmos DB "${databaseId}/changelogs" ...`
);

for (const entry of entries) {
  await container.items.upsert(entry);
  console.log(`  ✓ ${entry.id} (${entry.date})`);
}

console.log("Done. All changelog entries are up to date.");
