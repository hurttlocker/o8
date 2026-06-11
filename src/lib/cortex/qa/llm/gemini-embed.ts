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

// text-embedding-004 was RETIRED (404, verified live 2026-06-11) — same
// model-rot failure mode as grok-4.1-fast. gemini-embedding-001 is the GA
// replacement; 768-dim truncation (re-normalized below) keeps entries at
// 1/4 memory with an identical rephrase-vs-unrelated cosine gap (measured
// 0.905 vs 0.505 at both 3072 and 768 dims).
const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIMS = 768;
const EMBED_TIMEOUT_MS = 5_000;

function resolveGeminiKey(): string | undefined {
  return process.env.GOOGLE_AI_API_KEY
    ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY
    ?? process.env.GEMINI_API_KEY;
}

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

export async function embedQuestion(text: string): Promise<number[] | null> {
  const apiKey = resolveGeminiKey();
  if (!apiKey || !text.trim()) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text }] }, outputDimensionality: EMBED_DIMS }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const json = await res.json() as { embedding?: { values?: number[] } };
    const values = json.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) return null;
    return unitNormalize(values);
  } catch {
    return null;
  }
}
