#!/usr/bin/env node
/**
 * publish-fixed — announce fixed reports in the public #fixed channel.
 *
 * The doctrine: intake is private (a report carries a screenshot of somebody's
 * whole screen and stack traces with their repo paths in them — that can never
 * go on a public board). The PUBLIC artifact is the fix. Open problems rot;
 * fixed ones never do. So we publish only wins, credited to whoever found them.
 *
 * The loop:
 *   1. Operator files a report  → private ops channel + a short id (A7F3K2),
 *                                 recorded in ~/.o8/feedback/reports.jsonl
 *   2. You fix it, and the commit carries a trailer:
 *
 *        fix(diff): stop blanking the panel on large worktrees
 *
 *        Fixes-Report: A7F3K2
 *
 *   3. This script (run at release time) finds the trailer, looks the id up in
 *      the ledger, and posts to #fixed:
 *
 *        Diff panel went blank on large worktrees
 *        Reported by @kleosr · fixed in v0.1.592
 *
 * Usage:
 *   node scripts/publish-fixed.mjs                 # last tag..HEAD
 *   node scripts/publish-fixed.mjs --range v0.1.590..HEAD
 *   node scripts/publish-fixed.mjs --dry-run       # print, post nothing
 *
 * Webhook: O8_FIXED_WEBHOOK_URL, else `fixedWebhookUrl` in o8.release.json (the
 * gitignored release config that already holds the Sentry DSN). Absent → refuses
 * to run, rather than silently dropping somebody's credit.
 *
 * Idempotent: every published id is recorded in ~/.o8/feedback/published.json, so
 * re-running on an overlapping range will not double-post.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const rangeFlag = process.argv.indexOf('--range');
const EMBED_COLOR = 0x16a34a; // green — this channel only ever carries wins.

function dataDir() {
  return process.env.O8_DATA_DIR || process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.o8');
}
const FEEDBACK_DIR = path.join(dataDir(), 'feedback');
const LEDGER = path.join(FEEDBACK_DIR, 'reports.jsonl');
const PUBLISHED = path.join(FEEDBACK_DIR, 'published.json');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** env wins; else the gitignored o8.release.json — never a literal in source. */
function resolveFixedWebhook() {
  const fromEnv = process.env.O8_FIXED_WEBHOOK_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = JSON.parse(readFileSync(path.join(process.cwd(), 'o8.release.json'), 'utf8'));
    const url = typeof cfg.fixedWebhookUrl === 'string' ? cfg.fixedWebhookUrl.trim() : '';
    return url || null;
  } catch {
    return null;
  }
}

function defaultRange() {
  try {
    const lastTag = git(['describe', '--tags', '--abbrev=0']);
    return `${lastTag}..HEAD`;
  } catch {
    // No tags yet (fresh clone, or a repo that has never released).
    return 'HEAD~20..HEAD';
  }
}

/** Every `Fixes-Report:` trailer in the range, mapped to the commit that carried it. */
function collectFixedIds(range) {
  // \x00-delimited so a commit body with newlines cannot corrupt the parse.
  const raw = git(['log', range, '--format=%H%x00%s%x00%b%x00%x00']);
  const found = new Map(); // id -> { sha, subject }

  for (const entry of raw.split('\x00\x00')) {
    const [sha, subject, body] = entry.split('\x00');
    if (!sha?.trim()) continue;
    const text = `${subject ?? ''}\n${body ?? ''}`;
    // `Fixes-Report: A7F3K2` or `Fixes-Report: A7F3K2, B2M9QP`
    for (const match of text.matchAll(/^\s*Fixes-Report:\s*(.+)$/gim)) {
      for (const id of match[1].split(/[,\s]+/)) {
        const clean = id.trim().toUpperCase();
        if (clean && !found.has(clean)) {
          found.set(clean, { sha: sha.trim().slice(0, 8), subject: (subject ?? '').trim() });
        }
      }
    }
  }
  return found;
}

function readLedger() {
  if (!existsSync(LEDGER)) return new Map();
  const byId = new Map();
  for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record?.id) byId.set(String(record.id).toUpperCase(), record);
    } catch {
      // skip malformed line
    }
  }
  return byId;
}

function readPublished() {
  try {
    if (!existsSync(PUBLISHED)) return new Set();
    const parsed = JSON.parse(readFileSync(PUBLISHED, 'utf8'));
    return new Set(Array.isArray(parsed?.ids) ? parsed.ids : []);
  } catch {
    return new Set();
  }
}

function writePublished(ids) {
  if (!existsSync(FEEDBACK_DIR)) mkdirSync(FEEDBACK_DIR, { recursive: true });
  writeFileSync(PUBLISHED, `${JSON.stringify({ ids: [...ids] }, null, 2)}\n`, 'utf8');
}

function appVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function postFixed(webhookUrl, report, commit, version) {
  const credit = report.reporter
    ? `Reported by @${report.reporter} · fixed in v${version}`
    : `Fixed in v${version}`;

  const payload = {
    username: 'o8',
    embeds: [{
      title: report.title,
      description: credit,
      color: EMBED_COLOR,
      footer: { text: `report ${report.id} · ${commit.sha}` },
    }],
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Discord returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
  }
}

async function main() {
  const range = rangeFlag >= 0 ? process.argv[rangeFlag + 1] : defaultRange();
  const webhookUrl = resolveFixedWebhook();

  if (!webhookUrl && !DRY_RUN) {
    console.error('✗ No #fixed webhook — nothing published.');
    console.error('  Set O8_FIXED_WEBHOOK_URL, or add "fixedWebhookUrl" to o8.release.json. Or pass --dry-run.');
    process.exit(1);
  }

  const fixedIds = collectFixedIds(range);
  if (fixedIds.size === 0) {
    console.log(`No Fixes-Report: trailers in ${range} — nothing to publish.`);
    return;
  }

  const ledger = readLedger();
  const published = readPublished();
  const version = appVersion();
  const posted = [];
  const missing = [];

  for (const [id, commit] of fixedIds) {
    if (published.has(id)) continue; // already announced — never double-post
    const report = ledger.get(id);
    if (!report) {
      missing.push({ id, commit });
      continue;
    }

    if (DRY_RUN) {
      const credit = report.reporter ? `@${report.reporter}` : 'anonymous';
      console.log(`  [dry-run] ${id} · ${report.title} — ${credit} → v${version}`);
    } else {
      await postFixed(webhookUrl, report, commit, version);
    }
    posted.push(id);
  }

  if (!DRY_RUN && posted.length > 0) {
    for (const id of posted) published.add(id);
    writePublished(published);
  }

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Published ${posted.length} fix${posted.length === 1 ? '' : 'es'} from ${range}.`);

  // A trailer that names an id we have no record of is a silent hole in the loop:
  // somebody's report gets fixed and they are never told. Say so, loudly.
  if (missing.length > 0) {
    console.warn(`\n⚠ ${missing.length} trailer(s) reference an unknown report id — not published:`);
    for (const { id, commit } of missing) {
      console.warn(`  ${id} (${commit.sha} "${commit.subject}") — no such id in ${LEDGER}`);
    }
    console.warn('  The report was filed on another machine, or the id was mistyped.');
  }
}

main().catch((err) => {
  console.error('✗ publish-fixed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
