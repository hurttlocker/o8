#!/usr/bin/env node
/*
 * o8.run docs drift detection.
 *
 * The o8.run documentation (o8-site) stamps each page with the source files it
 * describes (`diffAgainst`). This script — run on every PR here — fetches that
 * manifest, compares it against the files the PR changed, and flags any doc
 * whose tracked source moved, so the docs never silently drift from the app.
 *
 * It only FLAGS (a PR comment); it never edits docs. Source of truth for the
 * map is o8.run, so this repo carries no copy to drift.
 *
 * Env:
 *   MANIFEST_URL           default https://o8.run/api/docs/manifest
 *   BASE_SHA / HEAD_SHA    PR range (CI); falls back to origin/main..HEAD
 *   PR_NUMBER              the PR to comment on (CI)
 *   DRIFT_CHANGED_FILES    override changed-file list (comma/newline) — for local dry-run
 *   DRIFT_DRY_RUN=1        print the comment instead of posting it
 */

import { execSync } from "node:child_process";

const MANIFEST_URL = process.env.MANIFEST_URL || "https://o8.run/api/docs/manifest";
const MARKER = "<!-- o8-docs-drift -->";

function changedFiles() {
  if (process.env.DRIFT_CHANGED_FILES) {
    return process.env.DRIFT_CHANGED_FILES.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  const base = process.env.BASE_SHA || "origin/main";
  const head = process.env.HEAD_SHA || "HEAD";
  try {
    return execSync(`git diff --name-only ${base} ${head}`, { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// a doc "tracks" a changed file if the file equals a diffAgainst entry or sits
// under it (entries may be files like "README.md" or dirs like "src/lib/cortex/qa")
function tracks(diffAgainst, files) {
  const hits = [];
  for (const src of diffAgainst) {
    for (const f of files) {
      if (f === src || f.startsWith(src.endsWith("/") ? src : `${src}/`)) hits.push(f);
    }
  }
  return [...new Set(hits)];
}

async function main() {
  const files = changedFiles();
  if (!files.length) {
    console.log("[docs-drift] no changed files; nothing to check.");
    return;
  }

  let manifest;
  try {
    const res = await fetch(MANIFEST_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    console.log(`[docs-drift] could not fetch manifest (${MANIFEST_URL}): ${e.message}. Skipping (non-blocking).`);
    return;
  }

  const affected = [];
  for (const doc of manifest.docs ?? []) {
    const hits = tracks(doc.diffAgainst ?? [], files);
    if (hits.length) affected.push({ doc, hits });
  }

  if (!affected.length) {
    console.log("[docs-drift] no o8.run docs track the changed files. ✅");
    return;
  }

  const body = [
    MARKER,
    "### 📝 o8.run docs may need updating",
    "",
    "This PR changes source that the public docs describe. Review whether these pages are still accurate (and bump their stamp in o8-site if so):",
    "",
    ...affected.map(
      ({ doc, hits }) =>
        `- **[${doc.title}](${doc.url})** \`${doc.slug}\` — tracks ${hits.map((h) => `\`${h}\``).join(", ")}`,
    ),
    "",
    `_Flagged by docs-drift against ${MANIFEST_URL}. Docs only — nothing is auto-edited._`,
  ].join("\n");

  if (process.env.DRIFT_DRY_RUN === "1" || !process.env.PR_NUMBER) {
    console.log("[docs-drift] DRY RUN — would post this comment:\n");
    console.log(body);
    return;
  }

  // Upsert: edit the existing marker comment if present, else create one.
  const pr = process.env.PR_NUMBER;
  try {
    const existing = JSON.parse(
      execSync(`gh pr view ${pr} --json comments --jq '[.comments[] | select(.body | contains("${MARKER}")) | .url] | .[0] // ""'`, {
        encoding: "utf8",
      }).trim() || '""',
    );
    const tmp = `/tmp/docs-drift-${pr}.md`;
    execSync(`cat > ${tmp}`, { input: body });
    if (existing) {
      execSync(`gh api -X PATCH ${existing.replace("https://github.com/", "repos/").replace(/\/pull\/\d+#issuecomment-/, "/issues/comments/")} -f body=@${tmp}`, { stdio: "inherit" });
    } else {
      execSync(`gh pr comment ${pr} --body-file ${tmp}`, { stdio: "inherit" });
    }
    console.log(`[docs-drift] flagged ${affected.length} doc(s) on PR #${pr}.`);
  } catch (e) {
    // Fall back to a fresh comment; never fail the build over a comment.
    try {
      execSync(`gh pr comment ${pr} --body ${JSON.stringify(body)}`, { stdio: "inherit" });
    } catch {
      console.log(`[docs-drift] could not post comment: ${e.message} (non-blocking).`);
    }
  }
}

main();
