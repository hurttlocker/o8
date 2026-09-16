/**
 * Operator corrections retriever (#2219).
 *
 * Surfaces rejection reasons (approvals) and steer messages (lane events) for
 * the repos in scope, so a question like "why was the parser change rejected?"
 * cites the operator's own words instead of guessing from outcomes.
 *
 * Ranking is plain token overlap against reason + title + packet id. When the
 * question itself asks about rejections, steering, or feedback, every in-scope
 * correction qualifies and recency breaks ties.
 */

import 'server-only';

import path from 'node:path';

import { readOperatorCorrections, type OperatorCorrection } from '@/lib/cortex/operator-corrections';
import type { RetrieverInput, RetrieverResult, TypedRow } from '@/lib/cortex/qa/types';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';

const DEFAULT_LIMIT = 8;
const SCAN_LIMIT = 100;
const CORRECTION_INTENT = /\b(reject|rejected|rejection|steer|steered|correct|correction|feedback|pushback|disagree|denied)\b/i;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'was', 'why', 'what', 'did', 'does', 'with', 'this', 'that', 'from', 'about',
  'how', 'who', 'when', 'where', 'are', 'were', 'has', 'have', 'had', 'its', 'into', 'our', 'operator',
]);

function scopedRepoPaths(input: RetrieverInput): string[] {
  const active = getActiveProjectScopeForRepoSync(input.repoPath);
  if (input.repoPath?.trim()) {
    const explicit = path.resolve(input.repoPath);
    return active.repoInActiveProject ? [explicit, ...active.repoPaths] : [explicit];
  }
  return active.repoPaths;
}

function questionTokens(question: string): string[] {
  return [...new Set(
    question.toLowerCase().split(/[^a-z0-9_-]+/).filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  )];
}

function scoreCorrection(correction: OperatorCorrection, tokens: string[], question: string): number {
  const haystack = `${correction.reason} ${correction.title} ${correction.packetId ?? ''}`.toLowerCase();
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  const packetMention = correction.packetId && question.toLowerCase().includes(correction.packetId.toLowerCase()) ? 1 : 0;
  return (tokens.length > 0 ? matched / tokens.length : 0) + packetMention;
}

function toRow(correction: OperatorCorrection, score: number): TypedRow {
  const verb = correction.kind === 'rejected' ? 'Operator rejected' : 'Operator steered';
  return {
    citation: {
      kind: 'correction',
      rowId: correction.rowId,
      table: correction.table,
      excerpt: correction.reason.slice(0, 200),
      title: `${verb}: ${correction.title}`,
    },
    fields: {
      title: `${verb}: ${correction.title}`,
      body: correction.reason,
      correctionKind: correction.kind,
      packetId: correction.packetId,
      repoPath: correction.repoPath,
      source: correction.source,
      at: correction.at,
    },
    score,
  };
}

export async function correctionsRetriever(input: RetrieverInput): Promise<RetrieverResult> {
  const started = Date.now();
  const repoPaths = scopedRepoPaths(input);
  if (repoPaths.length === 0) return { retriever: 'corrections', rows: [], durationMs: Date.now() - started };

  const tokens = questionTokens(input.question);
  const intent = CORRECTION_INTENT.test(input.question);
  const rows = readOperatorCorrections({ repoPaths, limit: SCAN_LIMIT })
    .map((correction) => ({ correction, score: scoreCorrection(correction, tokens, input.question) }))
    .filter(({ score }) => score > 0 || intent)
    // Stable sort keeps the reader's newest-first order within equal scores.
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? DEFAULT_LIMIT)
    .map(({ correction, score }) => toRow(correction, score));

  return { retriever: 'corrections', rows, durationMs: Date.now() - started };
}
