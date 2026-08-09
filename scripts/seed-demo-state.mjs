#!/usr/bin/env node
/**
 * Demo state seeder — populates a clean install with everything the Context
 * Engine needs to look impressive on first launch (#744, the YC demo polish).
 *
 * Two effects, both idempotent:
 *
 *   1. Copies any `examples/directives/*.md` not already present in
 *      `~/.o8/directives/` (matched by the front-matter `id`). Lets us ship
 *      a curated default set without overwriting user-authored directives.
 *
 *   2. Inserts a realistic mix of `session_outcomes` rows for the cortex-ide
 *      repo (default; configurable via `--repo-path=...`). Skipped if the
 *      target repo already has >= MIN_OUTCOMES rows so re-runs don't pile
 *      on top of real data.
 *
 * Usage:
 *
 *   node scripts/seed-demo-state.mjs                 # seed cortex-ide repo
 *   node scripts/seed-demo-state.mjs --repo-path=/abs/path/to/repo
 *   node scripts/seed-demo-state.mjs --force-outcomes   # re-seed even if rows exist
 *   node scripts/seed-demo-state.mjs --directives-only
 *   node scripts/seed-demo-state.mjs --outcomes-only
 *
 * Safe to call from npm postinstall, dev runner, or by hand. Never destroys
 * existing data — if you need to start clean, delete `~/.o8/cortex-ide.db`
 * and the `~/.o8/directives/` dir manually first.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Config ──────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SEED_DIRECTIVE_DIR = join(REPO_ROOT, 'examples', 'directives');

function getDataDir() {
  return process.env.O8_DATA_DIR
    || process.env.CORTEX_IDE_DATA_DIR
    || join(homedir(), '.o8');
}

function getDbPath() {
  return process.env.CORTEX_IDE_DB_PATH || join(getDataDir(), 'cortex-ide.db');
}

function getDirectivesDir() {
  return join(getDataDir(), 'directives');
}

const DEFAULT_REPO_PATH = join(homedir(), 'cortex-ide');
const MIN_OUTCOMES = 5;

// ── CLI ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let repoPath = DEFAULT_REPO_PATH;
let forceOutcomes = false;
let directivesOnly = false;
let outcomesOnly = false;

for (const arg of args) {
  if (arg.startsWith('--repo-path=')) {
    repoPath = arg.slice('--repo-path='.length);
  } else if (arg === '--force-outcomes') {
    forceOutcomes = true;
  } else if (arg === '--directives-only') {
    directivesOnly = true;
  } else if (arg === '--outcomes-only') {
    outcomesOnly = true;
  } else if (arg === '--help' || arg === '-h') {
    console.log([
      'Usage: node scripts/seed-demo-state.mjs [options]',
      '',
      'Options:',
      '  --repo-path=<abs>       Repo to seed outcomes for (default: ~/cortex-ide)',
      '  --force-outcomes        Re-seed outcomes even if rows already exist',
      '  --directives-only       Skip the outcomes seed',
      '  --outcomes-only         Skip the directives seed',
      '  -h, --help              Show this help',
    ].join('\n'));
    process.exit(0);
  } else {
    console.warn(`[seed-demo-state] Ignoring unknown arg: ${arg}`);
  }
}

// ── Directives ──────────────────────────────────────────────────────────

const FRONT_MATTER_BOUNDARY = /^---\s*$/m;

function parseDirectiveId(raw) {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text.startsWith('---')) return null;
  const afterFirst = text.slice(3).trimStart();
  const closingIndex = afterFirst.search(FRONT_MATTER_BOUNDARY);
  if (closingIndex < 0) return null;
  const front = afterFirst.slice(0, closingIndex);
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (key === 'id') return line.slice(idx + 1).trim();
  }
  return null;
}

function collectExistingDirectiveIds(dir) {
  if (!existsSync(dir)) return new Set();
  const ids = new Set();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    try {
      const raw = readFileSync(join(dir, name), 'utf-8');
      const id = parseDirectiveId(raw);
      if (id) ids.add(id);
    } catch {
      // Ignore unreadable files — never block the seed on a parse error.
    }
  }
  return ids;
}

function seedDirectives() {
  if (!existsSync(SEED_DIRECTIVE_DIR)) {
    console.log(`[seed-demo-state] No seed dir at ${SEED_DIRECTIVE_DIR}; skipping directive seed.`);
    return { copied: 0, skipped: 0 };
  }

  const targetDir = getDirectivesDir();
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  const existingIds = collectExistingDirectiveIds(targetDir);
  let copied = 0;
  let skipped = 0;

  for (const name of readdirSync(SEED_DIRECTIVE_DIR)) {
    if (!name.endsWith('.md')) continue;
    const src = join(SEED_DIRECTIVE_DIR, name);
    let raw = '';
    try {
      raw = readFileSync(src, 'utf-8');
    } catch {
      continue;
    }
    const id = parseDirectiveId(raw);
    if (!id) {
      console.warn(`[seed-demo-state] ${name} has no id in front matter; skipping.`);
      continue;
    }
    if (existingIds.has(id)) {
      skipped++;
      continue;
    }
    const dest = join(targetDir, name);
    if (existsSync(dest)) {
      // Same filename, different id — let user-managed file win.
      skipped++;
      continue;
    }
    copyFileSync(src, dest);
    copied++;
  }

  console.log(`[seed-demo-state] Directives: copied ${copied}, skipped ${skipped} (already present).`);
  return { copied, skipped };
}

// ── Outcomes ────────────────────────────────────────────────────────────

/**
 * Realistic-looking session outcomes for a cortex-ide demo. All branch /
 * summary text is drawn from real recent merges so the Recall Card surfaces
 * believable history instead of placeholder gibberish.
 *
 * Mix is intentional:
 *   - 6 succeeded + reviewApproved=1 (clean merges)
 *   - 1 succeeded + reviewApproved=0 (rejected after review)
 *   - 1 partial (incomplete pass — orchestrator decomposed and retried)
 *   - 1 failed (genuine engine failure)
 *
 * Runtimes are spread across codex / gemini / opencode to show the fleet
 * isn't single-runtime. Costs and durations are inside plausible bands.
 */
const DEMO_OUTCOMES = [
  {
    branch: 'feat/recall-card-742',
    runtime: 'codex',
    outcome: 'succeeded',
    reviewApproved: 1,
    summary: 'Built the 3-row Context Recall Card hero — directives, recent outcomes, symbol graph — sandwiched into ThoughtsMissionPanel.',
    durationMin: 14,
    costUsd: 0.42,
    model: 'gpt-5.5-xhigh',
    daysAgo: 1,
    findings: 0,
  },
  {
    branch: 'feat/dispatch-context-injection-743',
    runtime: 'codex',
    outcome: 'succeeded',
    reviewApproved: 1,
    summary: 'Injected <context> block into packet bodies on dispatch — directives + outcomes + symbol graph with a 4000-char budget.',
    durationMin: 11,
    costUsd: 0.31,
    model: 'gpt-5.5-xhigh',
    daysAgo: 1,
    findings: 0,
  },
  {
    branch: 'feat/auto-index-repos-741',
    runtime: 'gemini',
    outcome: 'succeeded',
    reviewApproved: 1,
    summary: 'Auto-index every registered repo at boot via codebase-memory-mcp; surfaces an indexing chip on the first dispatch after a cold start.',
    durationMin: 9,
    costUsd: 0.08,
    model: 'gemini-2.5-pro',
    daysAgo: 2,
    findings: 1,
  },
  {
    branch: 'feat/mcp-register-codebase-memory-740',
    runtime: 'codex',
    outcome: 'succeeded',
    reviewApproved: 1,
    summary: 'Registered codebase-memory-mcp in .mcp.json + setup generator so a fresh install picks up the binary the first time the operator hits Recall.',
    durationMin: 7,
    costUsd: 0.18,
    model: 'gpt-5.5-xhigh',
    daysAgo: 2,
    findings: 0,
  },
  {
    branch: 'feat/codebase-memory-runtime-download-755',
    runtime: 'codex',
    outcome: 'succeeded',
    reviewApproved: 1,
    summary: 'Runtime-download codebase-memory-mcp on first launch — pull from GitHub Releases, verify checksum, drop into ~/.o8/bin so first-run is hands-off.',
    durationMin: 13,
    costUsd: 0.34,
    model: 'gpt-5.5-xhigh',
    daysAgo: 3,
    findings: 0,
  },
  {
    branch: 'fix/dispatch-popover-placement-752',
    runtime: 'gemini',
    outcome: 'succeeded',
    reviewApproved: 1,
    summary: 'Anchored Cmd+Shift+O popover at top-center of the active screen so multi-monitor setups stop opening off-screen on the wrong display.',
    durationMin: 6,
    costUsd: 0.05,
    model: 'gemini-2.5-pro',
    daysAgo: 4,
    findings: 0,
  },
  {
    branch: 'polish/orchestrator-empty-state-copy',
    runtime: 'opencode',
    outcome: 'succeeded',
    reviewApproved: 0,
    summary: 'Rewrote the orchestrator empty-state copy and quick-action card layout. Reviewer flagged the new copy as off-brand vs the locked design language.',
    durationMin: 8,
    costUsd: 0.04,
    model: 'opencode/deepseek-v4-flash-free',
    daysAgo: 5,
    findings: 3,
  },
  {
    branch: 'feat/packet-meta-rows-restyle',
    runtime: 'codex',
    outcome: 'partial',
    reviewApproved: null,
    summary: 'Started restyling packet metadata as Issues-style rows. Branch + repo rows landed cleanly; runtime + summary rows still using a native select that will need a popover follow-up.',
    durationMin: 22,
    costUsd: 0.51,
    model: 'gpt-5.5-xhigh',
    daysAgo: 6,
    findings: 2,
  },
  {
    branch: 'fix/midnight-blob-rgba-sweep',
    runtime: 'gemini',
    outcome: 'failed',
    reviewApproved: null,
    summary: 'Tried to swap hardcoded rgba whites for palette vars in the chrome surfaces. Pass collapsed glass into solid blobs across NavRail, status bar, and command palette — reverted before merge.',
    durationMin: 19,
    costUsd: 0.12,
    model: 'gemini-2.5-pro',
    daysAgo: 7,
    findings: 5,
  },
  {
    branch: 'feat/recall-card-symbol-graph-row',
    runtime: 'codex',
    outcome: 'succeeded',
    reviewApproved: 1,
    summary: 'Added the Symbol Graph row to the Context Recall Card — debounced trace_path call against codebase-memory-mcp, gracefully hides when the index is still building.',
    durationMin: 16,
    costUsd: 0.39,
    model: 'gpt-5.5-xhigh',
    daysAgo: 8,
    findings: 0,
  },
];

function makeOutcomeId(repoPath, daysAgo, runtime, branch) {
  // Deterministic id so re-runs don't pile up duplicate rows. Branch slug is
  // included so two same-day same-runtime outcomes don't collide.
  const repoSlug = repoPath.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const branchSlug = branch.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `seed-${repoSlug}-${daysAgo}d-${runtime}-${branchSlug}`;
}

function isoDaysAgo(days, jitterMinutes = 0) {
  const ms = Date.now() - days * 24 * 60 * 60 * 1000 + jitterMinutes * 60 * 1000;
  return new Date(ms).toISOString();
}

async function seedOutcomes(repoPath) {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    console.log(`[seed-demo-state] DB not yet initialized at ${dbPath}.`);
    console.log('[seed-demo-state] Launch o8 once to create it, then re-run this script.');
    return { inserted: 0, skipped: 0 };
  }

  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch (error) {
    console.error('[seed-demo-state] better-sqlite3 not available — run `npm install` first.');
    console.error(error.message);
    return { inserted: 0, skipped: 0 };
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');

  // Confirm the table exists before we start writing.
  const tableExists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_outcomes';")
    .get();
  if (!tableExists) {
    console.log('[seed-demo-state] session_outcomes table not found — DB schema not migrated yet.');
    console.log('[seed-demo-state] Launch o8 once so the schema lands, then re-run.');
    sqlite.close();
    return { inserted: 0, skipped: 0 };
  }

  const existingCount = sqlite
    .prepare('SELECT COUNT(*) as count FROM session_outcomes WHERE repo_path = ?')
    .get(repoPath);
  const existing = existingCount?.count ?? 0;

  if (existing >= MIN_OUTCOMES && !forceOutcomes) {
    console.log(
      `[seed-demo-state] Outcomes: ${repoPath} already has ${existing} rows (>= ${MIN_OUTCOMES}); skipping. Pass --force-outcomes to re-seed.`,
    );
    sqlite.close();
    return { inserted: 0, skipped: DEMO_OUTCOMES.length };
  }

  const insertStmt = sqlite.prepare(`
    INSERT OR REPLACE INTO session_outcomes (
      id, repo_path, branch, runtime, session_key, lane_id, packet_id,
      outcome, summary, attempts, retry_history_json, duration_ms,
      total_tokens, cost_usd, model, patterns_json, conflict_zones_json,
      changed_files_json, review_approved, review_findings_count,
      transcript_path, started_at, completed_at, created_at, plan_text
    ) VALUES (
      @id, @repo_path, @branch, @runtime, NULL, NULL, NULL,
      @outcome, @summary, 1, '[]', @duration_ms,
      @total_tokens, @cost_usd, @model, '[]', '[]',
      '[]', @review_approved, @review_findings_count,
      NULL, @started_at, @completed_at, datetime('now'), NULL
    )
  `);

  let inserted = 0;
  const tx = sqlite.transaction(() => {
    for (const row of DEMO_OUTCOMES) {
      const durationMs = row.durationMin * 60 * 1000;
      const completed = isoDaysAgo(row.daysAgo, 0);
      const started = isoDaysAgo(row.daysAgo, -row.durationMin);
      const id = makeOutcomeId(repoPath, row.daysAgo, row.runtime, row.branch);
      insertStmt.run({
        id,
        repo_path: repoPath,
        branch: row.branch,
        runtime: row.runtime,
        outcome: row.outcome,
        summary: row.summary,
        duration_ms: durationMs,
        total_tokens: Math.round(row.costUsd * 80_000),
        cost_usd: row.costUsd,
        model: row.model,
        review_approved: row.reviewApproved,
        review_findings_count: row.findings,
        started_at: started,
        completed_at: completed,
      });
      inserted++;
    }
  });
  tx();
  sqlite.close();

  console.log(
    `[seed-demo-state] Outcomes: inserted ${inserted} rows for ${repoPath} (had ${existing} before).`,
  );
  return { inserted, skipped: 0 };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[seed-demo-state] Data dir: ${getDataDir()}`);
  console.log(`[seed-demo-state] DB path:  ${getDbPath()}`);
  console.log(`[seed-demo-state] Repo:     ${repoPath}`);

  if (!outcomesOnly) {
    seedDirectives();
  }
  if (!directivesOnly) {
    await seedOutcomes(repoPath);
  }

  console.log('[seed-demo-state] Done.');
}

main().catch((error) => {
  console.error('[seed-demo-state] Failed:', error);
  process.exit(1);
});
