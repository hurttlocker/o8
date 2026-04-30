/**
 * Engineering Brain Indexer worker (#915 north star #2).
 *
 * Drains `facts_queue` FIFO, distills each comment via Claude/Codex CLI,
 * writes validated facts to `facts` (idempotent on fingerprint). The worker
 * is comments-only in v1 — docs / outcomes / directives / PRs are deferred
 * to phase 2.
 *
 * Lifecycle of one queue item:
 *   1. claimNext()                — atomic SELECT + UPDATE started_at.
 *   2. distillComment(body, cli)  — CLI call + JSON parse + validation.
 *   3. for each validated fact    — insert-or-replace into facts (idempotent
 *                                   on fingerprint = sha256(content+source_id)).
 *   4. completeQueueItem(id)      — mark done.
 *   On exception:
 *      failQueueItem(id, msg)     — bump attempts; after 3 mark poisoned.
 *
 * Re-running the worker on the same queue does NOT duplicate facts — the
 * INSERT OR REPLACE ON fingerprint guarantees that.
 */

import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';

import { probeIndexerCli, type IndexerCli } from './cli-probe';
import { distillComment, type DistilledFact } from './distill';
import { claimNext, completeQueueItem, failQueueItem, pendingQueueDepth } from './queue';

// ── Constants ────────────────────────────────────────────────────────────────

const CONFIDENCE_FLOOR = 0.6;
// Source-of-truth hierarchy (#915 follow-up). Comments are the lowest tier
// because they're conversational opinions, not project rules. Directives
// (1.0), merged PRs (0.95), and closed outcomes (0.9) outrank them.
const COMMENT_SOURCE_AUTHORITY = 0.7;

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;

/**
 * Resolve the worker concurrency. Order of precedence:
 *   1. opts.concurrency (caller override)
 *   2. O8_INDEXER_CONCURRENCY env (power-user knob)
 *   3. DEFAULT_CONCURRENCY = 2
 *
 * Clamped to [1, MAX_CONCURRENCY]. Each parallel worker spawns its own
 * Claude/Codex CLI subprocess (~200-400MB RAM each), so 4 is fine on a
 * 16GB Mac, 8 is the practical ceiling. Higher counts also risk hitting
 * upstream Anthropic/OpenAI rate limits.
 */
function resolveConcurrency(override?: number): number {
  const raw = override ?? Number.parseInt(process.env.O8_INDEXER_CONCURRENCY ?? '', 10);
  const value = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, value));
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface IndexerWorkerOptions {
  /** Max queue items to process this run. Default 100. */
  maxItems?: number;
  /**
   * Parallel worker count. Default 2 (regular users), 4 recommended for
   * power users on a fresh repo. Override via `O8_INDEXER_CONCURRENCY` env.
   * Clamped to [1, 8].
   */
  concurrency?: number;
}

export interface IndexerWorkerSummary {
  cli: IndexerCli | null;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  factsWritten: number;
  durationMs: number;
}

// ── Fact write ───────────────────────────────────────────────────────────────

interface FactInsertRow {
  factId: string;
  fact: DistilledFact;
  sourceId: string;
  repoPath: string | null;
  fingerprint: string;
  extractedBy: string;
}

/**
 * Compute the idempotency fingerprint. Hash includes both the content and
 * the source id so two facts that paraphrase the same thing on the same
 * source get one row, and the same content on different sources gets two.
 */
function fingerprintOf(content: string, sourceId: string): string {
  return createHash('sha256').update(`${sourceId}\n${content}`).digest('hex');
}

/**
 * Write validated facts to `facts`. INSERT OR REPLACE on the unique
 * fingerprint index makes re-runs idempotent. Returns the count of rows
 * actually inserted (post-confidence-floor; rows below the floor are dropped
 * silently and logged once at caller level).
 */
function writeFacts(rows: FactInsertRow[]): number {
  if (rows.length === 0) return 0;
  const sqlite = getSqlite();

  const insert = sqlite.prepare(
    `INSERT INTO facts (
       id, kind, content, source_kind, source_id, source_excerpt,
       repo_path, confidence, fingerprint, extracted_by, source_authority
     )
     VALUES (?, ?, ?, 'github_comment', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       kind = excluded.kind,
       content = excluded.content,
       source_excerpt = excluded.source_excerpt,
       repo_path = excluded.repo_path,
       confidence = excluded.confidence,
       extracted_by = excluded.extracted_by,
       source_authority = excluded.source_authority`,
  );

  let written = 0;
  const tx = sqlite.transaction((items: typeof rows) => {
    for (const row of items) {
      insert.run(
        row.factId,
        row.fact.kind,
        row.fact.content,
        row.sourceId,
        row.fact.source_excerpt,
        row.repoPath,
        row.fact.confidence,
        row.fingerprint,
        row.extractedBy,
        COMMENT_SOURCE_AUTHORITY,
      );
      written += 1;
    }
  });
  tx(rows);
  return written;
}

// ── Worker loop ──────────────────────────────────────────────────────────────

/**
 * Run the worker until the queue is empty or `maxItems` is reached. Probes
 * the CLI first; returns early when no CLI is available (free-tier path).
 *
 * Failure modes for individual items are wrapped in try/catch and routed to
 * `failQueueItem` — they never kill the loop.
 */
export async function runIndexerWorker(
  opts: IndexerWorkerOptions = {},
): Promise<IndexerWorkerSummary> {
  const start = Date.now();
  const maxItems = opts.maxItems ?? 100;
  const concurrency = resolveConcurrency(opts.concurrency);

  const summary: IndexerWorkerSummary = {
    cli: null,
    processed: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    factsWritten: 0,
    durationMs: 0,
  };

  const cli = await probeIndexerCli();
  summary.cli = cli;
  if (!cli) {
    summary.durationMs = Date.now() - start;
    return summary;
  }

  const totalDepth = pendingQueueDepth();
  const target = Math.min(totalDepth, maxItems);
  if (target === 0) {
    console.log('[indexer] queue empty — nothing to do.');
    summary.durationMs = Date.now() - start;
    return summary;
  }

  console.log(
    `[indexer] starting — cli=${cli} maxItems=${maxItems} concurrency=${concurrency} pending=${totalDepth}`,
  );

  // Shared counter so parallel workers cooperatively respect maxItems. The
  // claimNext() call is already atomic via SQLite transaction so we only
  // need to gate iteration count here, not row claiming.
  let claimedCount = 0;

  /** One worker loop. Pulls from the shared queue until maxItems is reached. */
  const workerLoop = async (workerId: number): Promise<void> => {
    while (true) {
      // Reserve a slot under the cap before claiming a row. If maxItems is
      // reached, stop. Race-safe because JS is single-threaded.
      if (claimedCount >= maxItems) return;
      const slot = claimedCount;
      claimedCount += 1;

      const item = claimNext();
      if (!item) {
        // Queue empty — give back the reserved slot so other workers can
        // see the empty signal too.
        claimedCount -= 1;
        return;
      }

      summary.processed += 1;
      const itemStart = Date.now();

      try {
        const facts = await distillComment({
          commentId: item.sourceId,
          body: item.body,
          repoPath: item.repoPath,
          cli,
        });

        const aboveFloor = facts.filter((f) => f.confidence >= CONFIDENCE_FLOOR);
        const belowFloor = facts.length - aboveFloor.length;

        if (aboveFloor.length === 0) {
          completeQueueItem(item.queueId);
          summary.skipped += 1;
          if (facts.length === 0) {
            console.log(
              `[indexer] [w${workerId} ${slot + 1}/${target}] ${item.sourceId} → 0 facts (${cli}-cli, ${Date.now() - itemStart}ms)`,
            );
          } else {
            console.log(
              `[indexer] [w${workerId} ${slot + 1}/${target}] ${item.sourceId} → 0 facts (${belowFloor} below confidence floor, ${cli}-cli, ${Date.now() - itemStart}ms)`,
            );
          }
          continue;
        }

        const insertRows: FactInsertRow[] = aboveFloor.map((fact) => {
          const factId = randomUUID();
          const fingerprint = fingerprintOf(fact.content, item.sourceId);
          return {
            factId,
            fact,
            sourceId: item.sourceId,
            repoPath: item.repoPath,
            fingerprint,
            extractedBy: cli === 'claude' ? 'claude-cli' : 'codex-cli',
          };
        });

        const written = writeFacts(insertRows);
        summary.factsWritten += written;
        summary.succeeded += 1;
        completeQueueItem(item.queueId);

        const belowSuffix = belowFloor > 0 ? ` (+${belowFloor} dropped)` : '';
        console.log(
          `[indexer] [w${workerId} ${slot + 1}/${target}] ${item.sourceId} → ${written} facts written${belowSuffix} (${cli}-cli, ${((Date.now() - itemStart) / 1000).toFixed(1)}s)`,
        );
      } catch (err) {
        summary.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        failQueueItem(item.queueId, message);
        console.warn(
          `[indexer] [w${workerId} ${slot + 1}/${target}] ${item.sourceId} FAILED: ${message.slice(0, 200)} (${Date.now() - itemStart}ms)`,
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => workerLoop(i + 1)),
  );

  summary.durationMs = Date.now() - start;
  console.log(
    `[indexer] done — processed=${summary.processed} succeeded=${summary.succeeded} skipped=${summary.skipped} failed=${summary.failed} factsWritten=${summary.factsWritten} concurrency=${concurrency} (${(summary.durationMs / 1000).toFixed(1)}s)`,
  );

  return summary;
}
