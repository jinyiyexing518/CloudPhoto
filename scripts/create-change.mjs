#!/usr/bin/env node
/**
 * create-change.mjs
 *
 * Interactive CLI to create a new change file in changes/.
 * After writing the file it automatically regenerates data/changelog.json.
 *
 * Usage (from any location in the monorepo):
 *   yarn change
 */

import { createInterface } from "readline";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

async function main() {
  console.log("\n📝  New Change File\n");

  const id = (await ask("  ID (kebab-case, e.g. my-feature): ")).trim();
  if (!id || !/^[a-z0-9-]+$/.test(id)) {
    console.error("  ❌ ID must be kebab-case (lowercase letters, digits, hyphens).");
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const dateInput = (await ask(`  Date [${today}]: `)).trim();
  const date = dateInput || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("  ❌ Date must be YYYY-MM-DD.");
    process.exit(1);
  }

  const icon = (await ask("  Icon emoji [✨]: ")).trim() || "✨";
  const title = (await ask("  Title (short, Chinese OK): ")).trim();
  if (!title) { console.error("  ❌ Title is required."); process.exit(1); }

  const desc = (await ask("  Short description (one line): ")).trim();
  const details = (await ask("  Details (full explanation, optional): ")).trim();

  rl.close();

  const entry = { id, date, icon, title, ...(desc && { desc }), ...(details && { details }) };

  const changesDir = join(root, "changes");
  mkdirSync(changesDir, { recursive: true });

  const filename = `${date}-${id}.json`;
  const filepath = join(changesDir, filename);

  if (existsSync(filepath)) {
    console.error(`\n  ❌ Already exists: changes/${filename}`);
    process.exit(1);
  }

  writeFileSync(filepath, JSON.stringify(entry, null, 2) + "\n", "utf8");
  console.log(`\n  ✅ Created: changes/${filename}`);

  // Regenerate packages/client/public/changelog.json
  console.log("  ↺  Regenerating public/changelog.json...");
  execSync("node scripts/collect-changes.mjs", { cwd: root, stdio: "inherit" });

  console.log("\n  Next steps:");
  console.log(`    git add changes/${filename} packages/client/public/changelog.json`);
  console.log("    git commit -m 'chore: add change file for <feature>'\n");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
