/**
 * Cortex Q&A public API (epic #915 sub-2).
 *
 * `askCortex(question, repoPath)` — the single entry point used by:
 *   - The eval runner (src/lib/cortex/qa/eval/runner.ts)
 *   - Any script that needs a non-streaming answer (e.g. scripts/smoke-qa-ask.ts)
 *
 * For the streaming HTTP path see the POST handler in
 * src/app/api/cortex/ask/route.ts which calls `runAskPipeline()` directly.
 *
 * Cache:
 *   30-second in-process TTL keyed by sha256(question + repoPath).
 *   `?force=1` query param on the HTTP route bypasses it.
 *   Invalidation: not done in this module (the route handles it via maxAge
 *   headers; the in-process cache auto-expires after 30s).
 */

import 'server-only';

import { createHash } from 'node:crypto';

import { classifyQuestion } from '@/lib/cortex/qa/classifier';
import { composeClassA, composeClassB, type SseEmit } from '@/lib/cortex/qa/composer';
import { retrieveAll, unionMerge } from '@/lib/cortex/qa/retrieve';
import type { Citation, TypedRow } from '@/lib/cortex/qa/types';
import { getActiveProjectScopeForRepo } from '@/lib/repos/projects';

// ── In-process cache ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  answer: string;
  citations: Citation[];
  expiresAt: number;
}

const answerCache = new Map<string, CacheEntry>();

function cacheKey(question: string, repoPath: string | undefined, projectId: string | undefined): string {
  return createHash('sha256')
    .update(`${question}\x00${repoPath ?? ''}\x00${projectId ?? ''}`)
    .digest('hex');
}

function getCached(key: string): CacheEntry | null {
  const entry = answerCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    answerCache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key: string, entry: Omit<CacheEntry, 'expiresAt'>): void {
  answerCache.set(key, { ...entry, expiresAt: Date.now() + CACHE_TTL_MS });
  // Evict stale entries lazily.
  if (answerCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of answerCache) {
      if (now > v.expiresAt) answerCache.delete(k);
    }
  }
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface AskCortexResult {
  answer: string;
  citations: Citation[];
  class: 'A' | 'B';
  retrievalMs: number;
  classifyMs: number;
}

/**
 * Run the full Q&A pipeline and collect the result (non-streaming).
 * Used by the eval runner and smoke tests.
 *
 * @param bypassCache  When true, skip both the cache lookup and the cache
 *                     write. Used by the eval runner so sequential runs don't
 *                     reuse stale answers.
 */
export async function askCortex(
  question: string,
  repoPath: string | undefined,
  options: { bypassCache?: boolean; projectId?: string | null } = {},
): Promise<AskCortexResult> {
  const { bypassCache = false } = options;
  const projectId = options.projectId?.trim()
    || (await getActiveProjectScopeForRepo(repoPath)).projectId;
  const key = cacheKey(question, repoPath, projectId);
  if (!bypassCache) {
    const cached = getCached(key);
    if (cached) {
      return {
        answer: cached.answer,
        citations: cached.citations,
        class: 'A', // cached result — class doesn't matter
        retrievalMs: 0,
        classifyMs: 0,
      };
    }
  }

  // 1. Classify
  const classifyStart = Date.now();
  const classification = await classifyQuestion(question);
  const classifyMs = Date.now() - classifyStart;

  // 2. Retrieve
  const retrievalStart = Date.now();
  const results = await retrieveAll({
    question,
    repoPath,
    projectId,
    bm25Variants: classification.bm25Variants,
  });
  const topRows = unionMerge(results);
  const retrievalMs = Date.now() - retrievalStart;

  // [qa-debug] Log retrieval diagnostics so we can trace empty-answer false-positives.
  const isDebug = process.env.QA_DEBUG === '1';
  if (isDebug) {
    console.log('[qa-debug] question:', question);
    console.log('[qa-debug] bm25Variants:', classification.bm25Variants);
    for (const r of results) {
      console.log(`[qa-debug] retriever=${r.retriever} rows=${r.rows.length} durationMs=${r.durationMs}`);
    }
    console.log('[qa-debug] topRows after unionMerge:', topRows.length);
    console.log('[qa-debug] composer class:', classification.class);
    if (topRows.length === 0) {
      console.warn('[qa-debug] topRows is EMPTY — composer will respond "no data"');
    }
  }

  // 3. Compose (collect via emit accumulator)
  let answer = '';
  const citations: Citation[] = [];

  const emit: SseEmit = (name, payload) => {
    if (name === 'token') {
      answer += (payload as { text: string }).text ?? '';
    } else if (name === 'citation') {
      const p = payload as {
        kind: Citation['kind'];
        rowId: string;
        table: string;
        excerpt?: string;
        url?: string;
      };
      citations.push({
        kind: p.kind,
        rowId: p.rowId,
        table: p.table,
        excerpt: p.excerpt,
        url: p.url,
      });
    }
  };

  if (classification.class === 'A') {
    await composeClassA(question, repoPath, topRows, emit);
  } else {
    await composeClassB(question, repoPath, topRows, emit);
  }

  const result: AskCortexResult = {
    answer: answer.trim(),
    citations,
    class: classification.class,
    retrievalMs,
    classifyMs,
  };

  if (!bypassCache) {
    setCache(key, { answer: result.answer, citations });
  }
  return result;
}

/**
 * Streaming pipeline — called by the HTTP route handler.
 *
 * Runs classifier → retriever → composer in sequence, emitting SSE frames
 * via the provided `emit` callback as data arrives.
 *
 * @param force  When true, bypass the 30s cache and re-run the full pipeline.
 */
export async function runAskPipeline(
  question: string,
  repoPath: string | undefined,
  emit: SseEmit,
  force = false,
  requestedProjectId?: string | null,
): Promise<void> {
  const projectId = requestedProjectId?.trim()
    || (await getActiveProjectScopeForRepo(repoPath)).projectId;
  const key = cacheKey(question, repoPath, projectId);

  if (!force) {
    const cached = getCached(key);
    if (cached) {
      // Replay cached answer from SSE frames.
      emit('token', { text: cached.answer });
      for (const c of cached.citations) {
        emit('citation', c);
      }
      emit('done', {});
      return;
    }
  }

  // 1. Classify — determines which composer + BM25 variants to use.
  let classification: Awaited<ReturnType<typeof classifyQuestion>>;
  try {
    classification = await classifyQuestion(question);
  } catch (err) {
    console.warn('[qa][ask] classifier error:', err);
    classification = { class: 'B', bm25Variants: [question] };
  }

  // 2. Retrieve — run all three retrievers in parallel, RRF-merge.
  let topRows: TypedRow[];
  try {
    const results = await retrieveAll({
      question,
      repoPath,
      projectId,
      bm25Variants: classification.bm25Variants,
    });
    topRows = unionMerge(results);
  } catch (err) {
    console.warn('[qa][ask] retrieval error:', err);
    topRows = [];
  }

  // 3. Compose — stream answer tokens + citations.
  // We also accumulate so we can update the cache when done.
  let cachedAnswer = '';
  const cachedCitations: Citation[] = [];

  const trackingEmit: SseEmit = (name, payload) => {
    if (name === 'token') {
      cachedAnswer += (payload as { text: string }).text ?? '';
    } else if (name === 'citation') {
      const p = payload as {
        kind: Citation['kind'];
        rowId: string;
        table: string;
        excerpt?: string;
        url?: string;
      };
      cachedCitations.push({
        kind: p.kind,
        rowId: p.rowId,
        table: p.table,
        excerpt: p.excerpt,
        url: p.url,
      });
    }
    emit(name, payload);
  };

  if (classification.class === 'A') {
    await composeClassA(question, repoPath, topRows, trackingEmit);
  } else {
    await composeClassB(question, repoPath, topRows, trackingEmit);
  }

  // Store in cache for follow-up identical questions.
  if (cachedAnswer.trim()) {
    setCache(key, { answer: cachedAnswer.trim(), citations: cachedCitations });
  }
}
