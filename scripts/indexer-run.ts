/**
 * Standalone runner for the Engineering Brain Indexer (#915 north star #2).
 *
 * Usage:
 *   npx tsx scripts/indexer-run.ts                # default 200 items
 *   npx tsx scripts/indexer-run.ts --max=50       # cap to 50 items
 *
 * Walks every repo in `~/.o8/repos.json`, enqueues each repo's comments into
 * `facts_queue`, then drains up to `--max` items from the queue. Idempotent
 * — already-enqueued comments are skipped, and re-running the worker on the
 * same queue does not duplicate facts (fingerprint upsert).
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enqueueComments, pendingQueueDepth } from '@/lib/cortex/indexer/queue';
import { runIndexerWorker } from '@/lib/cortex/indexer/worker';

interface RepoRegistryRow {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  defaultBranch: string;
}
interface RepoRegistry {
  version: number;
  repos: RepoRegistryRow[];
}

function getDataDir(): string {
  return (
    process.env.O8_DATA_DIR ||
    process.env.CORTEX_IDE_DATA_DIR ||
    path.join(os.homedir(), '.o8')
  );
}

function loadRepos(): RepoRegistryRow[] {
  const registryPath = path.join(getDataDir(), 'repos.json');
  if (!existsSync(registryPath)) return [];
  try {
    const raw = readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(raw) as RepoRegistry;
    return Array.isArray(parsed.repos) ? parsed.repos : [];
  } catch (err) {
    console.warn('[indexer-run] failed to read repos.json:', err instanceof Error ? err.message : err);
    return [];
  }
}

function parseMaxArg(): number {
  const arg = process.argv.find((a) => a.startsWith('--max='));
  if (!arg) return 200;
  const n = Number(arg.slice('--max='.length));
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.floor(n);
}

async function main() {
  const start = Date.now();
  const maxItems = parseMaxArg();

  // Step 1 — enqueue every repo's comments.
  const repos = loadRepos();
  console.log(`[indexer-run] found ${repos.length} repo${repos.length === 1 ? '' : 's'} in registry`);

  let totalEnqueued = 0;
  for (const repo of repos) {
    try {
      const enqueued = enqueueComments(repo.localPath);
      totalEnqueued += enqueued;
      console.log(
        `[indexer-run] enqueued ${enqueued} comments for ${repo.name} (${repo.localPath})`,
      );
    } catch (err) {
      console.warn(
        `[indexer-run] enqueue failed for ${repo.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(`[indexer-run] total enqueued this run: ${totalEnqueued}`);
  console.log(`[indexer-run] queue depth: ${pendingQueueDepth()} pending`);

  // Step 2 — drain.
  console.log(`[indexer-run] running worker with maxItems=${maxItems}`);
  const summary = await runIndexerWorker({ maxItems });

  // Step 3 — print summary.
  const elapsed = Date.now() - start;
  console.log('');
  console.log('────────────────────────────────────────────────────────────');
  console.log('[indexer-run] summary');
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  cli            : ${summary.cli ?? 'disabled (no CLI available)'}`);
  console.log(`  enqueued       : ${totalEnqueued}`);
  console.log(`  processed      : ${summary.processed}`);
  console.log(`  succeeded      : ${summary.succeeded}`);
  console.log(`  skipped (0 fx) : ${summary.skipped}`);
  console.log(`  failed         : ${summary.failed}`);
  console.log(`  facts written  : ${summary.factsWritten}`);
  console.log(`  remaining      : ${pendingQueueDepth()}`);
  console.log(`  total elapsed  : ${(elapsed / 1000).toFixed(1)}s`);
  console.log('────────────────────────────────────────────────────────────');

  // Exit non-zero only when the CLI was unavailable (so cron can detect it).
  if (!summary.cli) process.exit(2);
}

main().catch((err) => {
  console.error('[indexer-run] FAIL', err);
  process.exit(1);
});
