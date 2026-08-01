import 'server-only';

import { dot } from '@/lib/cortex/qa/llm/gemini-embed';

/** Calibrated for gemini-embedding-001 at 768 dimensions. */
export const SEMANTIC_HIT_THRESHOLD = 0.86;

const invalidators = new Set<() => void>();

export function registerSemanticCacheInvalidator(invalidate: () => void): () => void {
  invalidators.add(invalidate);
  return () => invalidators.delete(invalidate);
}

export function invalidateRegisteredSemanticCaches(): void {
  for (const invalidate of invalidators) invalidate();
}

export function normalizeSemanticCacheQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function findSemanticMatch(
  vector: number[],
  candidates: Array<{ key: string; vector: number[] }>,
  threshold = SEMANTIC_HIT_THRESHOLD,
): { key: string; score: number } | null {
  let best: { key: string; score: number } | null = null;
  for (const candidate of candidates) {
    const score = dot(vector, candidate.vector);
    if (score >= threshold && (best === null || score > best.score)) {
      best = { key: candidate.key, score };
    }
  }
  return best;
}
