#!/usr/bin/env node
/**
 * check-changes.mjs
 *
 * Called by .githooks/pre-push before every push.
 *
 * Logic:
 *   - Read the list of refs being pushed from stdin (git pre-push protocol).
 *   - For each branch being pushed, find all changed files in the range
 *     (remote HEAD → local HEAD).
 *   - If ANY code file changes are present but NO changes/ file is included,
 *     abort the push with a helpful message.
 *
 * Bypass: git push --no-verify
 */

import { execSync } from "child_process";
import { createInterface } from "readline";
import { dirname } from "path";
import { fileURLToPath } from "url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ZEROS = "0".repeat(40);

// Files that count as "code changes" requiring a change file.
const CODE_RE = /^(packages\/|scripts\/)/;
// Files that count as "change files".
const CHANGE_RE = /^changes\/[^/]+\.json$/;

function changedFiles(range) {
  try {
    return execSync(`git diff --name-only ${range}`, {
      encoding: "utf8",
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function filesForNewBranch(localSha) {
  // For a brand-new branch: compare against the common ancestor with origin/main,
  // falling back to all files in the single commit if no origin exists.
  try {
    const base = execSync(`git merge-base ${localSha} origin/main 2>/dev/null`, {
      encoding: "utf8",
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (base) return changedFiles(`${base}..${localSha}`);
  } catch { /* fall through */ }
  // Fallback: just look at the tip commit
  try {
    return execSync(`git show --name-only --format="" ${localSha}`, {
      encoding: "utf8",
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  const rl = createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) {
    if (line.trim()) lines.push(line.trim());
  }

  for (const line of lines) {
    const parts = line.split(" ");
    if (parts.length < 4) continue;

    const [, localSha, , remoteSha] = parts;

    // Skip deletions (local SHA = zeros)
    if (localSha === ZEROS) continue;

    const files =
      remoteSha === ZEROS
        ? filesForNewBranch(localSha)
        : changedFiles(`${remoteSha}..${localSha}`);

    const hasCode   = files.some((f) => CODE_RE.test(f));
    const hasChange = files.some((f) => CHANGE_RE.test(f));

    if (hasCode && !hasChange) {
      process.stderr.write([
        "",
        "  ❌  Push blocked — no change file found.",
        "",
        "  Your commits contain code changes but no entry in changes/.",
        "  Document what changed by running:",
        "",
        "      yarn change",
        "",
        "  Then commit the generated file and push again.",
        "  To skip this check: git push --no-verify",
        "",
      ].join("\n"));
      process.exit(1);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  // If the check itself errors, allow the push (fail open).
  process.stderr.write(`  ⚠  check-changes.mjs error: ${e.message}\n`);
  process.exit(0);
});
