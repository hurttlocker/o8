/**
 * Q&A retrieval orchestrator (epic #915 sub-1).
 *
 * Runs all three retrievers in parallel via `Promise.allSettled`, then
 * union-merges the typed rows with reciprocal rank fusion + dedup by
 * `kind+rowId`. Top 30 by merged score.
 *
 * Acceptance gate from #915: ≤200ms p95 on the founder's DB. The SQL and
 * graph retrievers run in tens of ms; FTS5 is the heaviest (string-search
 * across N indexes), but indexed-on-write keeps it under the budget.
 */

import 'server-only';

import { retrieveFacts } from '@/lib/cortex/qa/retrievers/facts';
import { ftsRetriever } from '@/lib/cortex/qa/retrievers/fts';
import { graphRetriever } from '@/lib/cortex/qa/retrievers/graph';
import { sqlRetriever } from '@/lib/cortex/qa/retrievers/sql';
import type { RetrieverInput, RetrieverResult, TypedRow } from '@/lib/cortex/qa/types';

const MERGE_LIMIT = 30;
const RRF_K = 60;

/**
 * #915 north star #3 — facts are pre-extracted (high-trust) and would otherwise
 * compete fairly via RRF against raw prose rows that share token overlap with
 * the question. We pin up to 6 fact rows to the front of the merged top-30 so
 * the composer always sees them first. 6 is small enough to leave 24 slots for
 * non-fact rows; tunable. With 0 facts, behavior is identical to pre-pin RRF.
 */
const FACTS_PIN_LIMIT = 6;

/**
 * #1119 — spec-ingest directives are sectioned, deterministic prose extracted
 * from the repo's canonical specs (CLAUDE.md / AGENTS.md / DESIGN.md / docs/**)
 * by the #1114 ingestion job. They're the highest-authority source for
 * design/convention/architecture questions but lost to the facts pin: short,
 * high-confidence facts about an *older* spec version would crowd out the
 * just-ingested section.
 *
 * Pin up to 4 spec-ingest directives ABOVE facts so the composer's lead
 * citation tracks the substrate, not stale chat distillations. 4 is small
 * enough that lookup-class questions still surface 6 facts in the top 10.
 */
const SPEC_INGEST_PIN_LIMIT = 4;

/**
 * Run every retriever in parallel. Each retriever swallows its own errors
 * and returns an empty `rows` on failure — `Promise.allSettled` is just a
 * belt-and-braces guard so a hard throw in one retriever can't take the
 * whole orchestrator down.
 */
export async function retrieveAll(input: RetrieverInput): Promise<RetrieverResult[]> {
  // #915 north star #1 — `retrieveFacts` joins the parallel fan-out as a peer
  // retriever. It contributes rows to the same RRF union below; MERGE_LIMIT
  // is unchanged so facts compete fairly. Composer-side high-rank injection
  // (#3) is a separate agent.
  const settled = await Promise.allSettled([
    sqlRetriever(input),
    ftsRetriever(input),
    graphRetriever(input),
    retrieveFacts(input),
  ]);

  return settled.map((entry, idx) => {
    if (entry.status === 'fulfilled') return entry.value;
    const retriever: RetrieverResult['retriever'] = (['sql', 'fts', 'graph', 'facts'] as const)[idx];
    console.warn(
      `[qa][retrieve] ${retriever} retriever rejected:`,
      entry.reason instanceof Error ? entry.reason.message : entry.reason,
    );
    return { retriever, rows: [], durationMs: 0 };
  });
}

/**
 * Union-merge results from multiple retrievers. RRF over the per-retriever
 * rank, dedup by `kind+rowId`, top `MERGE_LIMIT`.
 *
 * Why RRF here too (the FTS retriever already RRF'd internally): RRF is
 * stable under union — adding a new retriever just adds another contributor
 * to each row's score. Citations from multiple retrievers (e.g. an outcome
 * the SQL retriever picked because it's recent AND the FTS retriever picked
 * because it matches the question) get a higher merged score than either
 * alone, which is exactly what we want for the LLM composer.
 *
 * Pin order (above the RRF pool):
 *   1. Spec-ingest directives (up to SPEC_INGEST_PIN_LIMIT) — #1119. The
 *      #1114 spec-ingest job extracts canonical specs (CLAUDE.md / DESIGN.md /
 *      AGENTS.md / docs/**) into per-section directives. They're the
 *      highest-authority answer for design/convention/architecture questions
 *      and must outrank facts distilled from older chat/PRs about the same
 *      topic. Identified by id prefix `spec-ingest:`.
 *   2. Facts (up to FACTS_PIN_LIMIT) — #915 north star #3. Pre-extracted,
 *      BM25-ranked high-confidence rows.
 *   3. RRF pool — everything else (raw directives, outcomes, PRs, issues,
 *      docs, comments, symbols, project rows).
 *
 * Pinned rows are removed from the RRF pool so they don't double-occupy slots.
 * With zero spec-ingest directives + zero facts the output is identical to
 * pre-pin RRF.
 */
export function unionMerge(results: RetrieverResult[]): TypedRow[] {
  // Separate the facts retriever output before RRF so we can pin its
  // highest-scoring rows above everything else. Non-facts retrievers feed
  // the union as before.
  const factsResult = results.find((r) => r.retriever === 'facts');
  const otherResults = results.filter((r) => r.retriever !== 'facts');

  // #1119 — pull spec-ingest directives out of the FTS retriever's results
  // and pin them ABOVE facts. The FTS retriever already filtered to in-scope
  // directives via `directiveAppliesToRepo`, so anything we see here is
  // safe to surface. We keep their FTS RRF score ordering so the top-ranked
  // spec section for the question wins.
  const ftsResult = otherResults.find((r) => r.retriever === 'fts');
  const pinnedSpecIngest: TypedRow[] = ftsResult
    ? [...ftsResult.rows]
        .filter(
          (row) =>
            row.citation.kind === 'directive' &&
            typeof row.citation.rowId === 'string' &&
            row.citation.rowId.startsWith('spec-ingest:'),
        )
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, Math.min(SPEC_INGEST_PIN_LIMIT, MERGE_LIMIT))
    : [];

  // Take up to FACTS_PIN_LIMIT facts in their retriever's existing order
  // (retrieveFacts sorts by BM25 rank descending — score field). Cap so the
  // combined pin (spec-ingest + facts) never exceeds MERGE_LIMIT.
  const factsBudget = Math.max(0, MERGE_LIMIT - pinnedSpecIngest.length);
  const pinnedFacts: TypedRow[] = factsResult
    ? [...factsResult.rows]
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, Math.min(FACTS_PIN_LIMIT, factsBudget))
    : [];

  // Build a key set so we can drop any duplicate that surfaces from another
  // retriever (extremely unlikely — only facts retriever emits 'fact' kind —
  // but cheap insurance against future cross-retriever overlap).
  const pinnedKeys = new Set<string>();
  for (const row of pinnedSpecIngest) {
    pinnedKeys.add(`${row.citation.kind}:${row.citation.rowId}`);
  }
  for (const row of pinnedFacts) {
    pinnedKeys.add(`${row.citation.kind}:${row.citation.rowId}`);
  }

  const scores = new Map<string, number>();
  const rows = new Map<string, TypedRow>();

  for (const result of otherResults) {
    // Sort each retriever's rows by their pre-existing score (FTS uses RRF
    // internally; SQL/graph give 1) so the top-ranked row gets rank 0.
    const sorted = [...result.rows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    sorted.forEach((row, idx) => {
      const key = `${row.citation.kind}:${row.citation.rowId}`;
      if (pinnedKeys.has(key)) return; // already pinned above the merge
      const contribution = 1 / (RRF_K + idx);
      const prev = scores.get(key) ?? 0;
      scores.set(key, prev + contribution);

      const existing = rows.get(key);
      if (!existing) {
        // First contributor — clone so we don't mutate the retriever's row.
        rows.set(key, { ...row, score: contribution });
      } else {
        existing.score = (existing.score ?? 0) + contribution;
        // Prefer the longest excerpt — gives the composer more context.
        if (
          row.citation.excerpt &&
          (!existing.citation.excerpt ||
            row.citation.excerpt.length > existing.citation.excerpt.length)
        ) {
          existing.citation = { ...existing.citation, excerpt: row.citation.excerpt };
        }
      }
    });
  }

  const remainingSlots = Math.max(
    0,
    MERGE_LIMIT - pinnedSpecIngest.length - pinnedFacts.length,
  );
  const mergedNonFacts = [...rows.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, remainingSlots);

  return [...pinnedSpecIngest, ...pinnedFacts, ...mergedNonFacts];
}
