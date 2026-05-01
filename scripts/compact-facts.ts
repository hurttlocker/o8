/**
 * Engineering Brain — fact compactor (#915 north star follow-up).
 *
 * CLI wrapper around src/lib/cortex/compactor.ts. The compaction logic
 * lives in the library so it can also be called from the in-process
 * scheduler (compactor-scheduler.ts) that ws-server boots.
 *
 * This script preserves full backwards-compatibility so the launchd plist
 * and any existing cron invocations continue to work unchanged.
 *
 * Seven jobs:
 *
 *   1. GC orphans — facts whose source row has been deleted upstream
 *   2. Drop low-confidence — facts below a configurable floor (default 0.3)
 *   3. Collapse exact-content dupes — keep highest-confidence, delete rest
 *   4. Time-decay confidence — stale facts fade toward the noise floor
 *   5. Token-Jaccard near-dup merge — paraphrases collapsed into one row
 *   6. Contradiction surfacing — heuristic report-only, opt-in
 *   7. Cosine near-dup merge (#962) — semantic dedup using stored embeddings
 *      (facts.embedding BLOB). Pairs with cosine ≥ --cosine-threshold
 *      (default 0.92) get collapsed the same way as Job 5. Disabled by
 *      default (pass --cosine-dedup to enable). Skipped with a warning when
 *      no rows have embeddings yet (run backfill-fact-embeddings.ts first).
 *
 * Usage:
 *   npx tsx scripts/compact-facts.ts                  # apply all jobs
 *   npx tsx scripts/compact-facts.ts --dry-run        # report, no writes
 *   npx tsx scripts/compact-facts.ts --floor=0.4      # custom conf floor
 *   npx tsx scripts/compact-facts.ts --decay-days=60  # custom decay age
 *   npx tsx scripts/compact-facts.ts --jaccard=0.9    # stricter merge
 *   npx tsx scripts/compact-facts.ts --skip-decay     # disable Job 4
 *   npx tsx scripts/compact-facts.ts --skip-jaccard   # disable Job 5
 *   npx tsx scripts/compact-facts.ts --cosine-dedup   # enable Job 7 (semantic dedup)
 *   npx tsx scripts/compact-facts.ts --cosine=0.95    # stricter cosine threshold
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { runCompaction } from '../src/lib/cortex/compactor.js';

function parseNumber(arg: string | undefined, fallback: number): number {
  if (!arg) return fallback;
  const v = Number(arg.split('=')[1]);
  return Number.isFinite(v) ? v : fallback;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const skipDecay = argv.includes('--skip-decay');
  const skipJaccard = argv.includes('--skip-jaccard');
  const reportContradictions = argv.includes('--report-contradictions');
  const cosineDedup = argv.includes('--cosine-dedup');
  const confidenceFloor = parseNumber(argv.find((a) => a.startsWith('--floor=')), 0.3);
  const decayDays = parseNumber(argv.find((a) => a.startsWith('--decay-days=')), 90);
  const decayFactor = parseNumber(argv.find((a) => a.startsWith('--decay-factor=')), 0.9);
  const jaccardThreshold = parseNumber(argv.find((a) => a.startsWith('--jaccard=')), 0.85);
  const cosineThreshold = parseNumber(argv.find((a) => a.startsWith('--cosine=')), 0.92);
  const contradictionMinOverlap = parseNumber(
    argv.find((a) => a.startsWith('--contradiction-overlap=')),
    8,
  );

  if (confidenceFloor < 0 || confidenceFloor > 1) {
    console.error('[compact-facts] --floor must be in [0, 1]');
    process.exit(1);
  }
  if (decayDays < 0) {
    console.error('[compact-facts] --decay-days must be >= 0');
    process.exit(1);
  }
  if (decayFactor < 0 || decayFactor > 1) {
    console.error('[compact-facts] --decay-factor must be in [0, 1]');
    process.exit(1);
  }
  if (jaccardThreshold < 0 || jaccardThreshold > 1) {
    console.error('[compact-facts] --jaccard must be in [0, 1]');
    process.exit(1);
  }
  if (cosineThreshold < 0 || cosineThreshold > 1) {
    console.error('[compact-facts] --cosine must be in [0, 1]');
    process.exit(1);
  }
  return {
    dryRun,
    confidenceFloor,
    decayDays,
    decayFactor,
    jaccardThreshold,
    skipDecay,
    skipJaccard,
    reportContradictions,
    contradictionMinOverlap,
    cosineDedup,
    cosineThreshold,
  };
}

function getDbPath(): string {
  const dataDir =
    process.env.O8_DATA_DIR ||
    process.env.CORTEX_IDE_DATA_DIR ||
    path.join(os.homedir(), '.o8');
  return path.join(dataDir, 'cortex-ide.db');
}

function main(): void {
  const args = parseArgs();
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    console.error(`[compact-facts] DB not found: ${dbPath}`);
    process.exit(1);
  }
  console.log(`[compact-facts] DB: ${dbPath}`);

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  runCompaction(args, db);

  db.close();
}

main();
