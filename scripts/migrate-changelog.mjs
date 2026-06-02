#!/usr/bin/env node
/**
 * One-time migration: splits data/changelog.json into individual changes/ files.
 * Safe to re-run — skips files that already exist.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const changesDir = join(root, "changes");
mkdirSync(changesDir, { recursive: true });

const entries = JSON.parse(readFileSync(join(root, "data", "changelog.json"), "utf8"));

let created = 0, skipped = 0;
for (const entry of entries) {
  const filename = `${entry.date}-${entry.id}.json`;
  const filepath = join(changesDir, filename);
  if (existsSync(filepath)) { skipped++; continue; }
  writeFileSync(filepath, JSON.stringify(entry, null, 2) + "\n", "utf8");
  console.log(`  created: changes/${filename}`);
  created++;
}
console.log(`\nDone. Created: ${created}, Skipped (already existed): ${skipped}`);
