/**
 * Doc → Facts batched distillation (#915 north star Phase 2b).
 *
 * Sibling of `distill.ts` (per-comment). Where comment distillation feeds one
 * body per CLI call, this packs N markdown chunks into one prompt and asks
 * the model to return a JSON object keyed by chunk id. That amortizes the
 * Claude CLI's ~60s bootstrap across the batch (~5x cheaper per chunk in the
 * common 8-per-batch case).
 *
 * The validation layer is the same shape as distill.ts:
 *   - kind must be in the allowed enum
 *   - source_excerpt must be a verbatim substring of the chunk
 *   - confidence must be a finite number in [0, 1]
 *   - content length 1..500
 *
 * Validation here is shape-only (kind + length). The script callsite enforces
 * the substring-of-chunk rule because it has the chunk's text on hand.
 */

import 'server-only';

import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import {
  buildDocumentationFactExtractionPromptV1,
  STRICT_JSON_SYSTEM_PROMPTS_V1,
} from '@/lib/prompts/v1';

// ── Types ────────────────────────────────────────────────────────────────────

const ALLOWED_KINDS = [
  'decision',
  'spec',
  'process',
  'incident',
  'ownership',
  'cross_repo',
  'directive',
  'other',
] as const;

export type DocFactKind = (typeof ALLOWED_KINDS)[number];

export interface DocChunkInput {
  id: string;
  repoName: string;
  relPath: string;
  headingPath: string[];
  text: string;
}

export interface DocFact {
  kind: DocFactKind;
  content: string;
  source_excerpt: string;
  confidence: number;
}

export interface DistillBatchInput {
  chunks: DocChunkInput[];
  /** CLI / API timeout in ms. Default 240_000 — batch prompts are bigger. */
  timeoutMs?: number;
}

export interface DistillBatchResult {
  factsByChunkId: Map<string, DocFact[]>;
  /** Best-effort estimate (sum of input chars / 4). Useful for cost tracking. */
  estTokens: number;
}

// ── JSON parsing ────────────────────────────────────────────────────────────

interface RawFact {
  kind?: unknown;
  content?: unknown;
  source_excerpt?: unknown;
  confidence?: unknown;
}

/**
 * Parse the model output. Tolerates ```json fences, leading/trailing prose,
 * and trims to the first '{' .. last '}' substring before JSON.parse. Returns
 * a generic record so the caller can validate per-chunk.
 */
function parseObjectJson(raw: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) return null;
  text = text.slice(firstBrace, lastBrace + 1);

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallthrough
  }
  return null;
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateRawFact(raw: RawFact): DocFact | null {
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
  if (!ALLOWED_KINDS.includes(kind as DocFactKind)) return null;

  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (content.length === 0 || content.length > 500) return null;

  const excerpt = typeof raw.source_excerpt === 'string' ? raw.source_excerpt : '';
  if (excerpt.length === 0 || excerpt.length > 200) return null;

  let confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.7;
  if (!Number.isFinite(confidence)) confidence = 0.7;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  return {
    kind: kind as DocFactKind,
    content,
    source_excerpt: excerpt,
    confidence,
  };
}

// ── Public entrypoint ───────────────────────────────────────────────────────

/**
 * Distill a batch of chunks. Returns a Map keyed by chunk id; chunks that the
 * model omits or for which the response can't be parsed map to empty arrays
 * (the caller then writes nothing for them and marks them done so they won't
 * be retried indefinitely).
 *
 * Throws when the underlying CLI call throws — the script callsite catches
 * and marks every chunk in the failed batch as `failed` for the next retry.
 */
export async function distillDocChunkBatch(
  input: DistillBatchInput,
): Promise<DistillBatchResult> {
  const factsByChunkId = new Map<string, DocFact[]>();
  for (const c of input.chunks) factsByChunkId.set(c.id, []);

  if (input.chunks.length === 0) {
    return { factsByChunkId, estTokens: 0 };
  }

  const prompt = buildDocumentationFactExtractionPromptV1(input.chunks);
  const estTokens = Math.ceil(prompt.length / 4);

  const result = await callSonnet({
    system: STRICT_JSON_SYSTEM_PROMPTS_V1.documentationFacts,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    timeoutMs: input.timeoutMs ?? 240_000,
  });

  const parsed = parseObjectJson(result.text);
  if (!parsed) {
    console.warn(
      `[doc-distill] batch parse failure (${input.chunks.length} chunks); first 200 chars: ${result.text.slice(0, 200)}`,
    );
    return { factsByChunkId, estTokens };
  }

  let totalSkipped = 0;
  for (const chunk of input.chunks) {
    const rawFacts = parsed[chunk.id];
    if (!Array.isArray(rawFacts)) continue;

    const validated: DocFact[] = [];
    for (const raw of rawFacts) {
      if (!raw || typeof raw !== 'object') continue;
      const fact = validateRawFact(raw as RawFact);
      if (fact) {
        validated.push(fact);
      } else {
        totalSkipped += 1;
      }
    }
    factsByChunkId.set(chunk.id, validated);
  }

  if (totalSkipped > 0) {
    console.log(
      `[doc-distill] batch validation skipped ${totalSkipped} fact${totalSkipped === 1 ? '' : 's'} ` +
        `(bad-kind / bad-length / bad-excerpt-len)`,
    );
  }

  return { factsByChunkId, estTokens };
}
