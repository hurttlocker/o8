/**
 * BM25 / FTS5 retriever (epic #915 sub-1).
 *
 * Runs the question (or pre-computed BM25 variants) against all four FTS5
 * indexes in parallel — outcomes, prs, issues, directives — then merges
 * the per-index top-20 hits via reciprocal rank fusion (RRF).
 *
 *   RRF score = sum over indexes of 1 / (60 + rank_in_index)
 *
 * The constant 60 is the canonical "k" from the Cormack/Clarke paper
 * (Reciprocal Rank Fusion outperforms Condorcet, 2009). Higher k = flatter
 * curve; 60 gives FTS5's BM25 enough room to express confidence without
 * a single retriever's #1 hit dominating the merge.
 *
 * Sub-200ms target. FTS5 is in-process and indexed-on-write, so the cost
 * is dominated by the join from FTS rowid → parent table for excerpt
 * rendering.
 */

import 'server-only';

import type { RetrieverInput, RetrieverResult, TypedRow } from '@/lib/cortex/qa/types';
import { getSqlite } from '@/lib/db';
import { isFts5Available } from '@/lib/db/v14-fts5-migration';

const PER_INDEX_LIMIT = 20;
// Comments compete with the rest of the indexes inside the FTS retriever's
// own RRF merge, then again in retrieve.ts. Capping the per-table input at
// 8 keeps comment hits from flooding the top-30 — they should be substrate
// for decisions/specs, not the dominant voice.
const PER_COMMENTS_LIMIT = 8;
const DEFAULT_LIMIT = 30;
const RRF_K = 60;

/** Sanitize a query string for FTS5 MATCH. FTS5 is picky:
 *   - Bare punctuation = parse error
 *   - Unbalanced quotes = parse error
 *   - Empty tokens after split = parse error
 *
 * We strip everything except alphanumerics + spaces, collapse runs of
 * whitespace, and quote each token as a prefix-allowed phrase so the
 * query is robust against operator typos.
 */
function buildMatchQuery(question: string): string | null {
  if (!question?.trim()) return null;
  const tokens = question
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  // Each token becomes a prefix-allowed phrase. OR-join them so any token
  // match scores. FTS5 treats unquoted ORs as AND by default; explicit OR
  // gives recall over precision, which is what we want before the RRF + LLM
  // composer narrows down.
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}

interface FtsRow {
  rowId: string;
  rank: number;
  excerpt: string;
}

function ftsSearch(
  sqlite: ReturnType<typeof getSqlite>,
  table: string,
  rowIdCol: string,
  match: string,
  limit: number = PER_INDEX_LIMIT,
): FtsRow[] {
  try {
    // bm25() returns a negative rank — lower is better. We negate so higher
    // scores are better, matching the rest of the codebase.
    const sql = `
      SELECT ${rowIdCol} AS rowId,
             -bm25(${table}) AS rank,
             snippet(${table}, -1, '«', '»', '…', 8) AS excerpt
      FROM ${table}
      WHERE ${table} MATCH ?
      ORDER BY bm25(${table})
      LIMIT ${limit}
    `;
    return sqlite.prepare(sql).all(match) as FtsRow[];
  } catch (error) {
    console.warn(
      `[qa][fts] ${table} match failed for ${JSON.stringify(match)}:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

interface OutcomeRow {
  id: string;
  summary: string;
  plan_text: string | null;
  repo_path: string;
  completed_at: string;
}

interface PrRow {
  pull_request_id: number;
  number: number;
  title: string;
  url: string;
  body: string | null;
  repo_full_name: string;
}

interface IssueRow {
  issue_id: number;
  number: number;
  title: string;
  url: string;
  body: string | null;
  repo_full_name: string;
}

/** Maps directive_id → typed row. Directives have no SQL parent, so we
 *  hold the FTS title/body in the row's `fields` directly. */
interface DirectiveRow {
  directive_id: string;
  title: string;
  body: string;
}

interface CommentRow {
  id: string;
  parent_kind: 'issue' | 'pull_request';
  parent_number: number;
  repo_full_name: string;
  author_login: string | null;
  body: string;
  url: string | null;
  updated_at: string | null;
}

export async function ftsRetriever(input: RetrieverInput): Promise<RetrieverResult> {
  const start = Date.now();
  const rows: TypedRow[] = [];

  try {
    const sqlite = getSqlite();
    if (!isFts5Available(sqlite)) {
      // FTS5 unavailable — return empty rows so the orchestrator can still
      // serve SQL + graph hits. No throw.
      return { retriever: 'fts', rows, durationMs: Date.now() - start };
    }

    // Variants come from the Flash classifier (later sub-issue). For now
    // we just OR them with the raw question to widen recall.
    const variants = input.bm25Variants?.length
      ? input.bm25Variants
      : [input.question];
    const matches = variants
      .map((v) => buildMatchQuery(v))
      .filter((m): m is string => Boolean(m));
    if (matches.length === 0) {
      return { retriever: 'fts', rows, durationMs: Date.now() - start };
    }

    // Run a single MATCH per variant per table, take the top-N per pair, then
    // dedupe by row id (keep the best rank). FTS5 doesn't accept bound params
    // for MATCH against multiple sub-queries cleanly, so we issue one prepare
    // per variant — cheap, ≤4 variants per question by design.

    type TableHits = Map<string, { rank: number; excerpt: string }>;
    const outcomesHits: TableHits = new Map();
    const prsHits: TableHits = new Map();
    const issuesHits: TableHits = new Map();
    const directivesHits: TableHits = new Map();
    const commentsHits: TableHits = new Map();

    const merge = (target: TableHits, hits: FtsRow[]) => {
      for (const hit of hits) {
        const prev = target.get(String(hit.rowId));
        if (!prev || hit.rank > prev.rank) {
          target.set(String(hit.rowId), { rank: hit.rank, excerpt: hit.excerpt });
        }
      }
    };

    for (const match of matches) {
      merge(outcomesHits, ftsSearch(sqlite, 'outcomes_fts', 'outcome_id', match));
      merge(prsHits, ftsSearch(sqlite, 'prs_fts', 'pr_id', match));
      merge(issuesHits, ftsSearch(sqlite, 'issues_fts', 'issue_id', match));
      merge(directivesHits, ftsSearch(sqlite, 'directives_fts', 'directive_id', match));
      // Comments table may not exist on installs that haven't applied schema
      // v15 yet — ftsSearch swallows the error and returns []. The retriever
      // stays no-op in that case and the rest of the FTS5 path keeps working.
      merge(
        commentsHits,
        ftsSearch(sqlite, 'comments_fts', 'comment_id', match, PER_COMMENTS_LIMIT),
      );
    }

    // Convert per-table maps into ranked lists, then RRF-merge into the
    // final TypedRow output. We score = sum of 1 / (k + rank_in_table).
    const rrfScores = new Map<string, number>();
    const rrfRows = new Map<string, TypedRow>();
    const accumulate = (key: string, score: number, row: TypedRow) => {
      const prev = rrfScores.get(key) ?? 0;
      rrfScores.set(key, prev + score);
      const existing = rrfRows.get(key);
      if (existing) {
        existing.score = (existing.score ?? 0) + score;
      } else {
        rrfRows.set(key, { ...row, score });
      }
    };

    // outcomes
    if (outcomesHits.size > 0) {
      const sortedIds = [...outcomesHits.entries()]
        .sort((a, b) => b[1].rank - a[1].rank)
        .map(([id]) => id);
      const records = sqlite
        .prepare(
          `SELECT id, summary, COALESCE(plan_text, '') AS plan_text, repo_path, completed_at
           FROM session_outcomes
           WHERE id IN (${sortedIds.map(() => '?').join(',')})`,
        )
        .all(...sortedIds) as OutcomeRow[];
      const byId = new Map(records.map((r) => [r.id, r]));
      sortedIds.forEach((id, idx) => {
        const record = byId.get(id);
        if (!record) return;
        const hit = outcomesHits.get(id)!;
        const score = 1 / (RRF_K + idx);
        accumulate(`outcome:${id}`, score, {
          citation: {
            kind: 'outcome',
            rowId: id,
            table: 'session_outcomes',
            excerpt: hit.excerpt,
          },
          fields: {
            id: record.id,
            summary: record.summary,
            planText: record.plan_text,
            repoPath: record.repo_path,
            completedAt: record.completed_at,
          },
          score: 0,
        });
      });
    }

    // prs
    if (prsHits.size > 0) {
      const sortedIds = [...prsHits.entries()]
        .sort((a, b) => b[1].rank - a[1].rank)
        .map(([id]) => id);
      const intIds = sortedIds.map((id) => Number(id)).filter((id) => Number.isFinite(id));
      if (intIds.length > 0) {
        const records = sqlite
          .prepare(
            `SELECT pull_request_id, number, title, url, body, repo_full_name
             FROM github_pull_requests
             WHERE pull_request_id IN (${intIds.map(() => '?').join(',')})`,
          )
          .all(...intIds) as PrRow[];
        const byId = new Map(records.map((r) => [String(r.pull_request_id), r]));
        sortedIds.forEach((id, idx) => {
          const record = byId.get(id);
          if (!record) return;
          const hit = prsHits.get(id)!;
          const score = 1 / (RRF_K + idx);
          accumulate(`pr:${id}`, score, {
            citation: {
              kind: 'pr',
              rowId: id,
              table: 'github_pull_requests',
              url: record.url,
              excerpt: hit.excerpt,
            },
            fields: {
              id: record.pull_request_id,
              number: record.number,
              title: record.title,
              url: record.url,
              repoFullName: record.repo_full_name,
            },
            score: 0,
          });
        });
      }
    }

    // issues
    if (issuesHits.size > 0) {
      const sortedIds = [...issuesHits.entries()]
        .sort((a, b) => b[1].rank - a[1].rank)
        .map(([id]) => id);
      const intIds = sortedIds.map((id) => Number(id)).filter((id) => Number.isFinite(id));
      if (intIds.length > 0) {
        const records = sqlite
          .prepare(
            `SELECT issue_id, number, title, url, body, repo_full_name
             FROM github_issues
             WHERE issue_id IN (${intIds.map(() => '?').join(',')})`,
          )
          .all(...intIds) as IssueRow[];
        const byId = new Map(records.map((r) => [String(r.issue_id), r]));
        sortedIds.forEach((id, idx) => {
          const record = byId.get(id);
          if (!record) return;
          const hit = issuesHits.get(id)!;
          const score = 1 / (RRF_K + idx);
          accumulate(`issue:${id}`, score, {
            citation: {
              kind: 'issue',
              rowId: id,
              table: 'github_issues',
              url: record.url,
              excerpt: hit.excerpt,
            },
            fields: {
              id: record.issue_id,
              number: record.number,
              title: record.title,
              url: record.url,
              repoFullName: record.repo_full_name,
            },
            score: 0,
          });
        });
      }
    }

    // directives — title/body live in the FTS index itself.
    if (directivesHits.size > 0) {
      const sortedIds = [...directivesHits.entries()]
        .sort((a, b) => b[1].rank - a[1].rank)
        .map(([id]) => id);
      const records = sqlite
        .prepare(
          `SELECT directive_id, title, body FROM directives_fts
           WHERE directive_id IN (${sortedIds.map(() => '?').join(',')})`,
        )
        .all(...sortedIds) as DirectiveRow[];
      const byId = new Map(records.map((r) => [r.directive_id, r]));
      sortedIds.forEach((id, idx) => {
        const record = byId.get(id);
        if (!record) return;
        const hit = directivesHits.get(id)!;
        const score = 1 / (RRF_K + idx);
        accumulate(`directive:${id}`, score, {
          citation: {
            kind: 'directive',
            rowId: id,
            table: 'directives_fts',
            sourcePath: `~/.o8/directives/${id}.md`,
            excerpt: hit.excerpt,
          },
          fields: {
            id: record.directive_id,
            title: record.title,
            body: record.body,
          },
          score: 0,
        });
      });
    }

    // comments — join back to github_comments for author + url metadata.
    // The table may not exist on installs that haven't applied v15 yet;
    // wrap in try/catch so the rest of the retriever still returns rows.
    if (commentsHits.size > 0) {
      try {
        const sortedIds = [...commentsHits.entries()]
          .sort((a, b) => b[1].rank - a[1].rank)
          .map(([id]) => id);
        const records = sqlite
          .prepare(
            `SELECT id, parent_kind, parent_number, repo_full_name, author_login,
                    body, url, updated_at
             FROM github_comments
             WHERE id IN (${sortedIds.map(() => '?').join(',')})`,
          )
          .all(...sortedIds) as CommentRow[];
        const byId = new Map(records.map((r) => [r.id, r]));
        sortedIds.forEach((id, idx) => {
          const record = byId.get(id);
          if (!record) return;
          const hit = commentsHits.get(id)!;
          const score = 1 / (RRF_K + idx);
          accumulate(`comment:${id}`, score, {
            citation: {
              kind: 'comment',
              rowId: id,
              table: 'github_comments',
              url: record.url ?? undefined,
              excerpt: hit.excerpt,
            },
            fields: {
              id: record.id,
              parentKind: record.parent_kind,
              parentNumber: record.parent_number,
              repoFullName: record.repo_full_name,
              author: record.author_login,
              body: record.body,
              url: record.url,
              updatedAt: record.updated_at,
            },
            score: 0,
          });
        });
      } catch (error) {
        // github_comments missing — pre-v15 install. Quietly skip.
        console.warn(
          '[qa][fts] comments join skipped:',
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Final pass — sort by RRF score, slice to limit. Caller can re-sort
    // or filter, but the retriever returns the most-relevant first.
    const sorted = [...rrfRows.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    rows.push(...sorted.slice(0, input.limit ?? DEFAULT_LIMIT));
  } catch (error) {
    console.warn(
      '[qa][fts] retriever failed:',
      error instanceof Error ? error.message : error,
    );
  }

  return {
    retriever: 'fts',
    rows,
    durationMs: Date.now() - start,
  };
}
