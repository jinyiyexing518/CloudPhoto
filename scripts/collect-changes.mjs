#!/usr/bin/env node
/**
 * collect-changes.mjs
 *
 * Reads every *.json file in changes/ (sorted newest-first by filename),
 * merges them into data/changelog.json, and prints a summary.
 *
 * This is the single source of truth pipeline:
 *   changes/<date>-<id>.json  →  data/changelog.json  →  Cosmos DB (via sync-changelog.mjs)
 *
 * Usage:
 *   node scripts/collect-changes.mjs
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const changesDir = join(root, "changes");
const outputPath = join(root, "data", "changelog.json");

mkdirSync(changesDir, { recursive: true });

const files = readdirSync(changesDir)
  .filter((f) => f.endsWith(".json"))
  .sort()      // lexicographic = chronological since filenames start with YYYY-MM-DD
  .reverse();  // newest first (matches existing changelog.json order)

if (files.length === 0) {
  console.warn("  ⚠  No change files found in changes/. data/changelog.json not updated.");
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

mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(outputPath, JSON.stringify(entries, null, 2) + "\n", "utf8");

console.log(`  ✅ Collected ${entries.length} change file(s) → data/changelog.json`);
