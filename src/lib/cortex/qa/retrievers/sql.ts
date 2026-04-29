/**
 * Structured-SQL retriever (epic #915 sub-1).
 *
 * Returns deterministic typed rows for "who/when/where/what" questions by
 * joining directives ↔ session_outcomes ↔ lanes ↔ github_pull_requests ↔
 * projects on `repo_path` / `packet_id`. Sub-100ms target on the founder's
 * DB.
 *
 * Output strategy: pick the most-recent live session_outcomes for the
 * requested repo (or any repo when none specified) and emit them as typed
 * rows with citations. The orchestrator will RRF-merge these with FTS hits
 * and graph hits — so we don't need a relevance model here, just freshness.
 */

import 'server-only';

import type { RetrieverInput, RetrieverResult, TypedRow } from '@/lib/cortex/qa/types';
import { getSqlite } from '@/lib/db';

const DEFAULT_LIMIT = 20;

interface OutcomeRow {
  id: string;
  repo_path: string;
  branch: string | null;
  runtime: string;
  outcome: string;
  summary: string;
  plan_text: string | null;
  packet_id: string | null;
  lane_id: string | null;
  completed_at: string;
  pr_number: number | null;
  pr_title: string | null;
  pr_url: string | null;
  pr_id: number | null;
}

export async function sqlRetriever(input: RetrieverInput): Promise<RetrieverResult> {
  const start = Date.now();
  const limit = input.limit ?? DEFAULT_LIMIT;
  const rows: TypedRow[] = [];

  try {
    const sqlite = getSqlite();
    const params: Array<string | number> = [];
    const where: string[] = ['so.valid_to IS NULL'];

    if (input.repoPath) {
      where.push('so.repo_path = ?');
      params.push(input.repoPath);
    }
    if (input.projectId) {
      where.push('so.project_id = ?');
      params.push(input.projectId);
    }

    // LEFT JOIN to github_pull_requests via the head branch matching the
    // outcome branch. Lossy by design — many outcomes don't have a PR yet
    // and that's fine, the citation just lacks a pr_url. We pick `MAX(pr_id)`
    // per outcome to deduplicate the join when multiple PRs share a head.
    const sql = `
      SELECT
        so.id,
        so.repo_path,
        so.branch,
        so.runtime,
        so.outcome,
        so.summary,
        so.plan_text,
        so.packet_id,
        so.lane_id,
        so.completed_at,
        pr.number AS pr_number,
        pr.title AS pr_title,
        pr.url AS pr_url,
        pr.pull_request_id AS pr_id
      FROM session_outcomes so
      LEFT JOIN (
        SELECT pull_request_id, number, title, url, head_ref_name
        FROM github_pull_requests
        WHERE pull_request_id IN (
          SELECT MAX(pull_request_id) FROM github_pull_requests GROUP BY head_ref_name
        )
      ) pr ON pr.head_ref_name = so.branch
      WHERE ${where.join(' AND ')}
      ORDER BY so.completed_at DESC
      LIMIT ?
    `;
    params.push(limit);

    const records = sqlite.prepare(sql).all(...params) as OutcomeRow[];

    for (const record of records) {
      const excerpt = record.summary.length > 160
        ? `${record.summary.slice(0, 157)}…`
        : record.summary;
      rows.push({
        citation: {
          kind: 'outcome',
          rowId: record.id,
          table: 'session_outcomes',
          excerpt,
        },
        fields: {
          id: record.id,
          repoPath: record.repo_path,
          branch: record.branch,
          runtime: record.runtime,
          outcome: record.outcome,
          summary: record.summary,
          planText: record.plan_text,
          packetId: record.packet_id,
          laneId: record.lane_id,
          completedAt: record.completed_at,
          prNumber: record.pr_number,
          prTitle: record.pr_title,
          prUrl: record.pr_url,
        },
        score: 1,
      });

      // When a PR is attached, emit a sibling pr citation so RRF can rank
      // the outcome and the PR separately. Cheap — one extra row per match.
      if (record.pr_id != null && record.pr_url) {
        rows.push({
          citation: {
            kind: 'pr',
            rowId: String(record.pr_id),
            table: 'github_pull_requests',
            url: record.pr_url,
            excerpt: record.pr_title ?? undefined,
          },
          fields: {
            id: record.pr_id,
            number: record.pr_number,
            title: record.pr_title,
            url: record.pr_url,
            outcomeId: record.id,
          },
          score: 1,
        });
      }
    }
  } catch (error) {
    console.warn(
      '[qa][sql] retriever failed:',
      error instanceof Error ? error.message : error,
    );
  }

  return {
    retriever: 'sql',
    rows,
    durationMs: Date.now() - start,
  };
}
