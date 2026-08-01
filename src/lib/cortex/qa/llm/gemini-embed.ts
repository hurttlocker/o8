/**
 * Tiny Gemini embedding helper for the semantic answer cache (#1226).
 *
 * Deliberately separate from src/lib/cortex/embeddings.ts — that module is
 * the OpenAI-keyed hybrid-scorer path for facts (gated on O8_HYBRID_SCORER);
 * this one rides the Gemini key that is already present in every install
 * (classifier Flash tier uses the same chain). Free-tier friendly: one small
 * call per cache store + one per semantic lookup, and lookups are skipped
 * entirely while the cache holds no vectored entries.
 *
 * Returns a UNIT-NORMALIZED vector so similarity is a plain dot product.
 * Null on any failure — callers treat that as a cache miss, never an error.
 */

import 'server-only';

import {
  assertUnderBrainDailyCap,
  recordBrainGeminiSpend,
} from '@/lib/cortex/qa/llm/brain-spend';
import { resolveEmbedRoute } from '@/lib/cortex/qa/llm/inference-route';

// text-embedding-004 was RETIRED (404, verified live 2026-06-11) — same
// model-rot failure mode as grok-4.1-fast. gemini-embedding-001 is the GA
// replacement; 768-dim truncation (re-normalized below) keeps entries at
// 1/4 memory with an identical rephrase-vs-unrelated cosine gap (measured
// 0.905 vs 0.505 at both 3072 and 768 dims).
export const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIMS = 768;
const EMBED_TIMEOUT_MS = 5_000;

/** Unit-normalize in place; returns null for zero vectors. */
export function unitNormalize(values: number[]): number[] | null {
  let sumSquares = 0;
  for (const v of values) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm === 0) return null;
  return values.map((v) => v / norm);
}

/** Dot product of two unit vectors = cosine similarity. */
export function dot(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += a[i] * b[i];
  return sum;
}

export function hasEmbeddingRoute(): boolean {
  return resolveEmbedRoute(EMBED_MODEL) !== null;
}

export async function embedQuestion(text: string): Promise<number[] | null> {
  if (!text.trim()) return null;
  // Direct (local Gemini key) or proxy (plan token) — see inference-route.ts.
  const route = resolveEmbedRoute(EMBED_MODEL);
  if (!route) return null;
  try {
    await assertUnderBrainDailyCap();
    // The direct Gemini API takes the native `content.parts` shape; the proxy
    // takes a flat `{ text }` (and builds the Gemini body server-side). Both
    // return `{ embedding: { values } }`, so parsing below is identical.
    const body =
      route.via === 'proxy'
        ? { text, outputDimensionality: EMBED_DIMS }
        : { content: { parts: [{ text }] }, outputDimensionality: EMBED_DIMS };
    const res = await fetch(route.url, {
      method: 'POST',
      headers: route.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json() as { embedding?: { values?: number[] } };
    const values = json.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) return null;
    recordBrainGeminiSpend(EMBED_MODEL, text, '', 'embedding');
    return unitNormalize(values);
  } catch {
    return null;
  }
}
