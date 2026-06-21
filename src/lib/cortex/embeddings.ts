/**
 * Cortex embedding service (#962).
 *
 * Wraps OpenAI `text-embedding-3-small` (1536-dim, ~$0.02/1M tokens).
 * Returns a `Float32Array` so callers can store it as a BLOB directly via
 * `Buffer.from(vec.buffer)` or compute cosine similarity in-process without
 * any additional serialization.
 *
 * Design principles:
 *   - Lazy: never called at import time. `OPENAI_API_KEY` missing → throws a
 *     clear error so callers can guard with `embeddings.isAvailable()`.
 *   - No silent fallback to zero-vectors (lessons from OSS Cortex #908 postmortem
 *     where 413/501 embeddings were silently zero under load).
 *   - Batch up to 100 texts in one API call to keep latency low.
 *   - Timeout: 30s per batch to prevent runaway calls from blocking the
 *     indexer worker.
 *
 * This module is server-only. It is not imported by any client path.
 */

import 'server-only';
import { resolveLocalInferenceBaseUrlSync, resolveLocalEmbedModelSync } from '@/lib/operator/defaults';

const OPENAI_EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS = 1536;
const BATCH_LIMIT = 100;
const TIMEOUT_MS = 30_000;

export function isAvailable(): boolean {
  // A local endpoint with an embed model makes the Brain work with zero cloud
  // keys; otherwise we need OpenAI. Either path satisfies "embeddings on".
  if (resolveLocalInferenceBaseUrlSync().trim() && resolveLocalEmbedModelSync().trim()) return true;
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Encode a Float32Array as a BLOB-compatible Buffer (little-endian float32).
 * Compatible with the column type: `facts.embedding BLOB`.
 */
export function encodeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Decode a BLOB buffer (as returned by better-sqlite3) back to Float32Array.
 * Returns null when `blob` is null/undefined (un-embedded row).
 */
export function decodeEmbedding(blob: Buffer | null | undefined): Float32Array | null {
  if (!blob) return null;
  // better-sqlite3 Buffers are slices of a shared pool: byteOffset is often
  // not 4-aligned (a direct Float32Array view throws RangeError) and the pool
  // is reused on later reads. Copy into a standalone, aligned buffer.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, Math.floor(blob.byteLength / 4));
}

/**
 * Cosine similarity between two 1536-dim float32 vectors.
 * Both must be the same length; throws when lengths differ.
 * Returns a value in [-1, 1]; 1 = identical direction.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `[embeddings] cosineSimilarity: vector length mismatch (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embed a single text string.
 * Throws when `OPENAI_API_KEY` is missing or the API call fails.
 */
export async function embedText(text: string): Promise<Float32Array> {
  const results = await embedBatch([text]);
  return results[0];
}

/**
 * Embed a batch of texts (up to BATCH_LIMIT).
 * Throws on API failure — callers must handle errors.
 * Returns one Float32Array per input text, in the same order.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  if (texts.length > BATCH_LIMIT) {
    throw new Error(
      `[embeddings] embedBatch: batch too large (${texts.length} > ${BATCH_LIMIT}). Split the input.`,
    );
  }

  // Local endpoint first — a zero-cloud-key dev embeds on their own machine.
  // Returns the local model's native dimension; for a fresh local install every
  // stored + query vector shares that dimension, so cosine stays consistent.
  const localBaseUrl = resolveLocalInferenceBaseUrlSync().trim();
  const localEmbedModel = resolveLocalEmbedModelSync().trim();
  if (localBaseUrl && localEmbedModel) {
    return embedBatchLocal(texts, localBaseUrl, localEmbedModel);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      '[embeddings] OPENAI_API_KEY is not set. Set it to enable embedding generation.',
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let body: { data: Array<{ embedding: number[] }> };
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_EMBED_MODEL,
        input: texts,
        dimensions: EMBED_DIMS,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '(no body)');
      throw new Error(
        `[embeddings] OpenAI API error ${response.status}: ${errorText.slice(0, 200)}`,
      );
    }

    body = (await response.json()) as { data: Array<{ embedding: number[] }> };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!body.data || body.data.length !== texts.length) {
    throw new Error(
      `[embeddings] OpenAI returned ${body.data?.length ?? 0} embeddings for ${texts.length} inputs`,
    );
  }

  return body.data.map((entry) => {
    if (!Array.isArray(entry.embedding) || entry.embedding.length !== EMBED_DIMS) {
      throw new Error(
        `[embeddings] unexpected embedding shape: length=${entry.embedding?.length}`,
      );
    }
    return new Float32Array(entry.embedding);
  });
}

/**
 * Embed via a local OpenAI-compatible endpoint (Ollama / LM Studio `/v1/embeddings`).
 * Accepts the model's native dimension (no 1536 enforcement) — zero cloud cost.
 */
async function embedBatchLocal(texts: string[], baseUrl: string, model: string): Promise<Float32Array[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '(no body)');
      throw new Error(`[embeddings] local endpoint error ${response.status}: ${errorText.slice(0, 200)}`);
    }
    const body = (await response.json()) as { data?: Array<{ embedding: number[] }> };
    if (!body.data || body.data.length !== texts.length) {
      throw new Error(`[embeddings] local endpoint returned ${body.data?.length ?? 0} embeddings for ${texts.length} inputs`);
    }
    return body.data.map((entry) => {
      if (!Array.isArray(entry.embedding) || entry.embedding.length === 0) {
        throw new Error(`[embeddings] unexpected local embedding shape: length=${entry.embedding?.length}`);
      }
      return new Float32Array(entry.embedding);
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
