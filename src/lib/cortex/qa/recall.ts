import 'server-only';

import { createHash } from 'node:crypto';
import { classifyQuestionForRecall } from '@/lib/cortex/qa/classifier';
import { assertUnderBrainDailyCap } from '@/lib/cortex/qa/llm/brain-spend';
import { embedQuestion, hasEmbeddingRoute } from '@/lib/cortex/qa/llm/gemini-embed';
import { retrieveAll, unionMerge } from '@/lib/cortex/qa/retrieve';
import {
  findSemanticMatch,
  normalizeSemanticCacheQuestion,
  registerSemanticCacheInvalidator,
} from '@/lib/cortex/qa/semantic-cache';
import type { ClassifierResult } from '@/lib/cortex/qa/classifier';
import type { RetrieverInput, RetrieverResult, TypedRow } from '@/lib/cortex/qa/types';

const RECALL_CACHE_TTL_MS = 30 * 60_000;
const RECALL_CACHE_MAX = 200;
const RECALL_ROW_LIMIT = 8;

interface RecallCacheEntry {
  expiresAt: number;
  rows: TypedRow[];
  scope: string;
  vector: number[];
}

interface RecallDependencies {
  assertSpend: () => Promise<void>;
  classify: (question: string) => Promise<ClassifierResult | null>;
  embed: (question: string) => Promise<number[] | null>;
  hasEmbedding: () => boolean;
  retrieve: (input: RetrieverInput) => Promise<RetrieverResult[]>;
}

export interface RecallRowsResult {
  rows: TypedRow[];
  cacheHit: boolean;
  classifyMs: number;
  retrievalMs: number;
  semanticMs: number;
}

const recallCache = new Map<string, RecallCacheEntry>();
const inFlight = new Map<string, Promise<RecallRowsResult>>();
let testOverrides: Partial<RecallDependencies> | null = null;

registerSemanticCacheInvalidator(() => recallCache.clear());

function dependencies(): RecallDependencies {
  return {
    assertSpend: assertUnderBrainDailyCap,
    classify: classifyQuestionForRecall,
    embed: embedQuestion,
    hasEmbedding: hasEmbeddingRoute,
    retrieve: retrieveAll,
    ...testOverrides,
  };
}

function scopeKey(repoPath: string, projectId?: string): string {
  return `${repoPath}\x00${projectId ?? ''}`;
}

function cacheKey(question: string, scope: string): string {
  return createHash('sha256')
    .update(`${normalizeSemanticCacheQuestion(question)}\x00${scope}`)
    .digest('hex');
}

function emptyResult(input: Partial<RecallRowsResult> = {}): RecallRowsResult {
  return {
    rows: [],
    cacheHit: false,
    classifyMs: 0,
    retrievalMs: 0,
    semanticMs: 0,
    ...input,
  };
}

function eligibleRows(rows: TypedRow[]): TypedRow[] {
  return rows.filter((row) => (
    row.citation.kind === 'directive'
    || row.citation.kind === 'outcome'
    || row.citation.kind === 'doc'
  )).slice(0, RECALL_ROW_LIMIT);
}

function pruneCache(now: number): void {
  if (recallCache.size <= RECALL_CACHE_MAX) return;
  for (const [key, entry] of recallCache) {
    if (entry.expiresAt < now || recallCache.size > RECALL_CACHE_MAX) recallCache.delete(key);
  }
}

async function runRecallRows(
  question: string,
  repoPath: string,
  projectId: string | undefined,
): Promise<RecallRowsResult> {
  const deps = dependencies();
  if (!deps.hasEmbedding()) return emptyResult();
  try {
    await deps.assertSpend();
  } catch {
    return emptyResult();
  }

  const scope = scopeKey(repoPath, projectId);
  const key = cacheKey(question, scope);
  const now = Date.now();
  const exact = recallCache.get(key);
  if (exact && exact.expiresAt >= now) {
    return emptyResult({ rows: exact.rows, cacheHit: true });
  }

  const candidates: Array<{ key: string; vector: number[] }> = [];
  for (const [candidateKey, entry] of recallCache) {
    if (entry.scope === scope && entry.expiresAt >= now) {
      candidates.push({ key: candidateKey, vector: entry.vector });
    }
  }

  let queryVector: number[] | null = null;
  let semanticMs = 0;
  if (candidates.length > 0) {
    const semanticStartedAt = performance.now();
    queryVector = await deps.embed(normalizeSemanticCacheQuestion(question));
    semanticMs = performance.now() - semanticStartedAt;
    if (!queryVector) return emptyResult({ semanticMs });
    const match = findSemanticMatch(queryVector, candidates);
    if (match) {
      const cached = recallCache.get(match.key);
      if (cached && cached.expiresAt >= now) {
        return emptyResult({ rows: cached.rows, cacheHit: true, semanticMs });
      }
    }
  }

  const classifyStartedAt = performance.now();
  const classification = await deps.classify(question);
  const classifyMs = performance.now() - classifyStartedAt;
  if (!classification) return emptyResult({ classifyMs, semanticMs });

  const retrievalStartedAt = performance.now();
  const retrieved = await deps.retrieve({
    question,
    repoPath,
    projectId,
    bm25Variants: classification.bm25Variants,
    questionClass: classification.class,
  });
  const rows = eligibleRows(unionMerge(retrieved, { questionClass: classification.class }));
  const retrievalMs = performance.now() - retrievalStartedAt;
  if (rows.length === 0) return emptyResult({ classifyMs, retrievalMs, semanticMs });

  if (!queryVector) {
    const semanticStartedAt = performance.now();
    queryVector = await deps.embed(normalizeSemanticCacheQuestion(question));
    semanticMs += performance.now() - semanticStartedAt;
  }
  if (queryVector) {
    recallCache.set(key, {
      expiresAt: Date.now() + RECALL_CACHE_TTL_MS,
      rows,
      scope,
      vector: queryVector,
    });
    pruneCache(Date.now());
  }

  return { rows, cacheHit: false, classifyMs, retrievalMs, semanticMs };
}

export async function recallRows(
  question: string,
  repoPath: string,
  projectId?: string,
): Promise<RecallRowsResult> {
  const scope = scopeKey(repoPath, projectId);
  const key = cacheKey(question, scope);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = runRecallRows(question, repoPath, projectId)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

export function resetRecallCacheForTests(): void {
  invalidateRecallCache();
  inFlight.clear();
  testOverrides = null;
}

export function invalidateRecallCache(): void {
  recallCache.clear();
}

export function seedRecallCacheForTests(input: {
  question: string;
  repoPath: string;
  projectId?: string;
  rows: TypedRow[];
  vector: number[];
}): void {
  const scope = scopeKey(input.repoPath, input.projectId);
  recallCache.set(cacheKey(input.question, scope), {
    expiresAt: Date.now() + RECALL_CACHE_TTL_MS,
    rows: input.rows,
    scope,
    vector: input.vector,
  });
}

export function setRecallDependenciesForTests(overrides: Partial<RecallDependencies> | null): void {
  testOverrides = overrides;
}
