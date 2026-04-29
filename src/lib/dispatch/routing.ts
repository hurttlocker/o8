/**
 * #747 — Per-runtime outcome telemetry → dispatch routing recommendation.
 *
 * Reads `session_outcomes` filtered by repo + temporal validity (#745) and
 * scores each runtime by win-rate (`merged_clean / total_outcomes`). The
 * recommender returns the top-scoring runtime when there's enough sample to
 * trust, plus the full evidence map so the UI can show a chip + tooltip.
 *
 * No automatic switching mid-dispatch — the orchestrator only consults this
 * helper at packet-create time and logs the recommendation alongside the
 * actual choice. The operator's manual runtime popover always wins.
 */
import 'server-only';

import { and, eq } from 'drizzle-orm';

import { getDb, sessionOutcomes } from '@/lib/db';
import { liveOutcomeFilter } from '@/lib/cortex/decay';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

/**
 * Minimum number of live outcomes a (repo, runtime) pair needs before its
 * win-rate is treated as a real signal. Below this we return `null` from
 * `recommendRuntime()` so the dispatcher falls through to the user's default
 * (codex). Three is chosen so the first few outcomes don't pin the chip on
 * a fluky early result.
 */
export const MIN_SAMPLE_SIZE = 3;

export interface RuntimeScore {
  runtime: OrchestratorRuntime;
  /** Win rate in [0, 1] — `merged_clean / total`. */
  score: number;
  /** Live outcomes used to compute the score. */
  total: number;
  /** Outcomes where `merged_clean = 1` — the numerator of `score`. */
  mergedClean: number;
}

export interface RuntimeRecommendation {
  /** Top-scoring runtime when sample size + delta justify a chip. */
  runtime: OrchestratorRuntime | null;
  /** Score of the recommended runtime, or 0 when none qualifies. */
  score: number;
  /**
   * Per-runtime evidence keyed by runtime id. Always populated for every
   * runtime that has at least one live outcome on the repo. Useful for
   * tooltips and audit logs.
   */
  evidence: Partial<Record<OrchestratorRuntime, RuntimeScore>>;
}

const EMPTY: RuntimeRecommendation = { runtime: null, score: 0, evidence: {} };

/**
 * Score every runtime that has live outcomes on the repo. Returns one row per
 * runtime — callers can pick the top, or render the full set in a tooltip.
 */
export async function scoreRuntimesForRepo(
  repoPath: string,
): Promise<RuntimeScore[]> {
  const trimmed = repoPath?.trim();
  if (!trimmed) return [];
  const db = getDb();
  if (!db) return [];

  try {
    // Drizzle's COUNT/SUM helpers can be flaky against the boolean column on
    // older sqlite builds — pull live rows and aggregate in JS. The dataset
    // is small (one repo's outcomes within the 30d validity window), so this
    // stays cheap.
    const rows = await db
      .select({
        runtime: sessionOutcomes.runtime,
        mergedClean: sessionOutcomes.mergedClean,
      })
      .from(sessionOutcomes)
      .where(and(eq(sessionOutcomes.repoPath, trimmed), liveOutcomeFilter()));

    if (rows.length === 0) return [];

    const tally = new Map<OrchestratorRuntime, { total: number; mergedClean: number }>();
    for (const row of rows) {
      const key = row.runtime as OrchestratorRuntime;
      const prior = tally.get(key) ?? { total: 0, mergedClean: 0 };
      prior.total += 1;
      // Treat NULL as "unknown, not clean" — the recommender penalises
      // outcomes that didn't make it to the merged-clean state. Legacy rows
      // backfilled from `review_approved + outcome` already supply 1/0.
      if (row.mergedClean === true) prior.mergedClean += 1;
      tally.set(key, prior);
    }

    return Array.from(tally.entries()).map(([runtime, agg]) => ({
      runtime,
      total: agg.total,
      mergedClean: agg.mergedClean,
      score: agg.total > 0 ? agg.mergedClean / agg.total : 0,
    }));
  } catch (error) {
    // Defensive: if the column is missing on a degraded DB the recommender
    // should silently fall through to "no opinion" rather than crash the
    // dispatch path.
    console.warn(
      '[dispatch-routing] scoreRuntimesForRepo failed:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Pick the best-known runtime for `repoPath`. Returns `{ runtime: null }` when
 * no runtime has at least `MIN_SAMPLE_SIZE` live outcomes — the caller should
 * fall through to the user's default. The `evidence` map is always populated
 * with whatever data we did find so the UI can still hint at coverage.
 *
 * Ties (equal score across two runtimes with sufficient sample) prefer the
 * one with the larger sample — more outcomes, more trustworthy signal.
 */
export async function recommendRuntime(
  repoPath: string,
): Promise<RuntimeRecommendation> {
  const scores = await scoreRuntimesForRepo(repoPath);
  if (scores.length === 0) return EMPTY;

  const evidence: Partial<Record<OrchestratorRuntime, RuntimeScore>> = {};
  for (const row of scores) {
    evidence[row.runtime] = row;
  }

  const eligible = scores
    // Only recommend runtimes the operator can actually dispatch to. Discovery-
    // only adapters (claude-code as of #650) still contribute evidence rows
    // because we want history showing in the popover, but they should never
    // be the surfaced "recommended" pick.
    .filter((row) => {
      const capability = ORCHESTRATOR_RUNTIMES[row.runtime];
      return capability?.dispatchable === true && row.total >= MIN_SAMPLE_SIZE;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-break on sample size, then alphabetic for determinism.
      if (b.total !== a.total) return b.total - a.total;
      return a.runtime.localeCompare(b.runtime);
    });

  if (eligible.length === 0) {
    return { runtime: null, score: 0, evidence };
  }

  const top = eligible[0]!;
  return { runtime: top.runtime, score: top.score, evidence };
}
