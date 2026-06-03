#!/usr/bin/env node
/**
 * create-change.mjs
 *
 * Interactive CLI to create a new change file in changes/.
 * After writing the file it automatically regenerates public/changelog.json.
 *
 * Usage:
 *   yarn change                              # interactive
 *   node scripts/create-change.mjs --pipe   # read JSON object from stdin
 *
 * Pipe usage (PowerShell, avoids escaping issues):
 *   $obj = [PSCustomObject]@{ id="my-feature"; date="2026-06-03"; type="feature"; title="标题"; summary="摘要" }
 *   $obj | ConvertTo-Json -Compress | node scripts/create-change.mjs --pipe
 *
 * The 'id' in the JSON file always matches the filename (YYYY-MM-DD-slug).
 * You may pass id with or without the date prefix — it will be normalised.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Ensure entry.id matches the filename stem (date-slug) and write the file. */
function writeEntry(entry) {
  const { date } = entry;
  let { id } = entry;
  if (!id || !date) {
    console.error("❌ Entry must have 'id' and 'date' fields.");
    process.exit(1);
  }

  // Normalise: id must include date prefix so it matches the filename
  if (!id.startsWith(date + "-")) {
    id = `${date}-${id}`;
  }
  // seq: stable creation-time ordering key (survives repeated Cosmos upserts)
  const normalised = { ...entry, id, seq: entry.seq ?? Date.now() };

  const changesDir = join(root, "changes");
  mkdirSync(changesDir, { recursive: true });

  const filename = `${id}.json`;
  const filepath = join(changesDir, filename);

  if (existsSync(filepath)) {
    console.error(`\n  ❌ Already exists: changes/${filename}`);
    process.exit(1);
  }

  writeFileSync(filepath, JSON.stringify(normalised, null, 2) + "\n", "utf8");
  console.log(`\n  ✅ Created: changes/${filename}`);

  console.log("  ↺  Regenerating public/changelog.json...");
  execSync("node scripts/collect-changes.mjs", { cwd: root, stdio: "inherit" });

  console.log("\n  Next steps:");
  console.log(`    git add changes/${filename} packages/client/public/changelog.json`);
  console.log("    git commit -m 'chore: add change file for <feature>'\n");
}

if (process.argv.includes("--pipe")) {
  // Read JSON from stdin (pipe mode — no TTY check needed)
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    try {
      const entry = JSON.parse(input.trim());
      writeEntry(entry);
    } catch (e) {
      console.error("❌ Invalid JSON from stdin:", e.message);
      process.exit(1);
    }
  });
} else {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}

async function main() {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

  console.log("\n📝  New Change File\n");

  const id = (await ask("  ID (kebab-case, e.g. my-feature): ")).trim();
  if (!id || !/^[a-z0-9-]+$/.test(id)) {
    console.error("  ❌ ID must be kebab-case (lowercase letters, digits, hyphens).");
    rl.close();
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const dateInput = (await ask(`  Date [${today}]: `)).trim();
  const date = dateInput || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("  ❌ Date must be YYYY-MM-DD.");
    rl.close();
    process.exit(1);
  }

  const icon = (await ask("  Icon emoji [✨]: ")).trim() || "✨";
  const title = (await ask("  Title (short, Chinese OK): ")).trim();
  if (!title) {
    console.error("  ❌ Title is required.");
    rl.close();
    process.exit(1);
  }

  const typeRaw = (await ask("  Type [feature/fix/improvement, default: feature]: ")).trim().toLowerCase();
  const type = ["fix", "improvement"].includes(typeRaw) ? typeRaw : "feature";

  const desc = (await ask("  Short description (one line): ")).trim();
  const details = (await ask("  Details (full explanation, optional): ")).trim();

  rl.close();

  const entry = { id, date, icon, title, type, ...(desc && { desc }), ...(details && { details }) };
  writeEntry(entry);
}
