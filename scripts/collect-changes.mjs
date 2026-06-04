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

// ── Schema normalization ────────────────────────────────────────────────────

function inferType(title = "") {
  const t = title.toLowerCase();
  if (
    t.startsWith("fix:") ||
    t.startsWith("修复") ||
    t.startsWith("bugfix") ||
    t.includes(" bug ") ||
    /^\[?fix\]?[:\s]/i.test(t)
  ) return "fix";
  if (
    t.startsWith("perf:") ||
    t.startsWith("chore:") ||
    t.startsWith("refactor:") ||
    t.startsWith("优化") ||
    t.startsWith("improvement")
  ) return "improvement";
  return "feature";
}

function typeIcon(type) {
  if (type === "fix") return "🔧";
  if (type === "improvement") return "⚡";
  return "✨";
}

/**
 * Normalize an entry so it always has:
 *  - type  (inferred from title when absent)
 *  - desc  (mapped from 'description' or 'summary' when 'desc' is absent)
 *  - icon  (default based on type when absent)
 */
function normalize(e) {
  const type = e.type ?? inferType(e.title ?? "");
  const desc = e.desc ?? e.description ?? e.summary ?? "";
  const icon = e.icon ?? typeIcon(type);
  // Drop legacy fields that aren't in the ChangelogEntry interface
  const { description: _d, summary: _s, impact: _i, breaking: _b, ...rest } = e;
  return { ...rest, type, desc, icon };
}

// ─────────────────────────────────────────────────────────────────────────────

const entries = files.map((f) => {
  try {
    return normalize(JSON.parse(readFileSync(join(changesDir, f), "utf8")));
  } catch (e) {
    console.error(`  ❌ Failed to parse changes/${f}: ${e.message}`);
    process.exit(1);
  }
});

// Sort newest-first: date desc, then seq desc within same date
entries.sort((a, b) => {
  const dateCmp = (b.date ?? "").localeCompare(a.date ?? "");
  if (dateCmp !== 0) return dateCmp;
  return (b.seq ?? 0) - (a.seq ?? 0);
});

writeFileSync(publicPath, JSON.stringify(entries, null, 2) + "\n", "utf8");

console.log(`  ✅ Collected ${entries.length} change file(s) → packages/client/public/changelog.json`);
