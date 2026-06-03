#!/usr/bin/env node
/**
 * collect-changes.mjs
 *
 * Reads every *.json file in changes/ (sorted newest-first by filename) and
 * writes packages/client/public/changelog.json so the WhatsNew popup can
 * fall back to it when the API server is not running.
 *
 * Pipeline:
 *   changes/<date>-<id>.json  →  public/changelog.json  (client fallback)
 *                             →  Cosmos DB              (via sync-changelog.mjs / GitHub Actions)
 *
 * Usage:
 *   node scripts/collect-changes.mjs
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const changesDir = join(root, "changes");
const publicPath = join(root, "packages", "client", "public", "changelog.json");

mkdirSync(changesDir, { recursive: true });

const files = readdirSync(changesDir)
  .filter((f) => f.endsWith(".json"));

if (files.length === 0) {
  console.warn("  ⚠  No change files found in changes/. public/changelog.json not updated.");
  process.exit(0);
}

const entries = files.map((f) => {
  try {
    return JSON.parse(readFileSync(join(changesDir, f), "utf8"));
  } catch (e) {
    console.error(`  ❌ Failed to parse changes/${f}: ${e.message}`);
    process.exit(1);
  }
});

// Sort by date field descending (newest first), fall back to filename order for ties.
entries.sort((a, b) => {
  const da = a?.date ?? "";
  const db = b?.date ?? "";
  return db.localeCompare(da);
});

writeFileSync(publicPath, JSON.stringify(entries, null, 2) + "\n", "utf8");

console.log(`  ✅ Collected ${entries.length} change file(s) → packages/client/public/changelog.json`);
