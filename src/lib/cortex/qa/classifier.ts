/**
 * Question classifier for the Cortex Q&A composer (epic #915 sub-2,
 * Haiku CLI fallback added in path-to-70 phase 1.6).
 *
 * Three-tier provider chain — all return the same { class, bm25Variants } shape:
 *   1. Gemini Flash JSON-mode (fast: ~50ms p50, ~200ms p95)
 *   2. Claude Haiku CLI       (Claude Max sub — kicks in when Flash 503s)
 *   3. Heuristic fallback     (lexical "why/how/explain" → Class B)
 *
 * Class A = lookup: "who/when/where/what" — expects a 1-2 fact answer
 * Class B = reasoning: "why/how/explain" — expects multi-fact composition
 *
 * BM25 variants are passed directly to `retrieveAll()` so the FTS5 retriever
 * can search with synonym/phrasing expansion.
 */

import 'server-only';

import { callHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';

export type QuestionClass = 'A' | 'B';

export interface ClassifierResult {
  class: QuestionClass;
  bm25Variants: string[];
}

const CLASSIFIER_PROMPT = `Classify the engineering question. Return ONLY strict JSON, no other text.
Output format: { "class": "A" | "B", "bm25_variants": ["v1","v2","v3"] }
Class A = lookup ("who/when/where/what"), 1-2 fact answer, deterministic
Class B = reasoning ("why/how/explain"), multi-fact composition required
bm25_variants: 3-5 alternate phrasings using synonyms and rephrasings of the question`;

/**
 * Classify the question with a 3-tier provider chain:
 *   1. Gemini Flash (fast, JSON-mode)
 *   2. Claude Haiku CLI (Claude Max subscription — no per-token cost)
 *   3. Heuristic fallback (lexical "why/how/explain" → Class B)
 *
 * Returns the classification + BM25 variants. Never throws; on full failure
 * returns the heuristic Class B so retrieval still gets at least one variant.
 */
export async function classifyQuestion(question: string): Promise<ClassifierResult> {
  // Tier 1: Flash (when a Google AI key is present).
  const apiKey = process.env.GOOGLE_AI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (apiKey) {
    const flashResult = await tryFlash(question, apiKey);
    if (flashResult) {
      console.info('[qa][classifier] resolved via flash');
      return flashResult;
    }
    // Flash failed — fall through to Haiku CLI.
  }

  // Tier 2: Haiku CLI (Claude Max subscription).
  const haikuResult = await tryHaiku(question);
  if (haikuResult) {
    console.info('[qa][classifier] resolved via haiku-cli');
    return haikuResult;
  }

  // Tier 3: heuristic.
  console.info('[qa][classifier] resolved via heuristic');
  return fallback(question);
}

/** Tier 1: Flash JSON-mode call. Returns null on any failure so caller can chain. */
async function tryFlash(question: string, apiKey: string): Promise<ClassifierResult | null> {
  try {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${CLASSIFIER_PROMPT}\n\nQuestion: ${question}`,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0,
        maxOutputTokens: 256,
      },
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!res.ok) {
      console.warn(`[qa][classifier] Flash API error ${res.status} — trying Haiku CLI`);
      return null;
    }

    const json = await res.json() as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!rawText.trim()) return null;

    return parseClassifierJson(rawText, question);
  } catch (err) {
    console.warn('[qa][classifier] Flash threw:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 2: Haiku CLI call. Mirrors Flash JSON shape; returns null on failure. */
async function tryHaiku(question: string): Promise<ClassifierResult | null> {
  try {
    const prompt = `${CLASSIFIER_PROMPT}\n\nQuestion: ${question}`;
    // 12s — Haiku CLI bootstrap (login-shell + node start) takes ~6-8s before
    // the model even runs. Flash already had its 8s shot above; this is the
    // slower fallback so a slightly-longer ceiling is fine.
    const text = await callHaiku(prompt, { timeoutMs: 12_000 });
    return parseClassifierJson(text, question);
  } catch (err) {
    console.warn('[qa][classifier] Haiku CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Parse a classifier JSON response (Flash or Haiku). Strips markdown fences
 * + preamble text. Returns null if the payload can't be coerced.
 */
function parseClassifierJson(rawText: string, question: string): ClassifierResult | null {
  let text = rawText.trim();
  // Strip markdown code fence if present.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    // Try to extract the first JSON object directly.
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      text = objMatch[0].trim();
    }
  }

  let parsed: { class?: unknown; bm25_variants?: unknown };
  try {
    parsed = JSON.parse(text) as { class?: unknown; bm25_variants?: unknown };
  } catch {
    return null;
  }

  const cls: QuestionClass = parsed.class === 'A' ? 'A' : 'B';
  const variants = Array.isArray(parsed.bm25_variants)
    ? (parsed.bm25_variants as unknown[])
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .slice(0, 5)
    : [];

  return {
    class: cls,
    bm25Variants: variants.length > 0 ? variants : [question],
  };
}

/** Safe fallback when Flash is unavailable or returns garbage. */
function fallback(question: string): ClassifierResult {
  // Heuristic: questions starting with "why" / "how" / "explain" → Class B.
  const lower = question.trim().toLowerCase();
  const cls: QuestionClass =
    lower.startsWith('why') || lower.startsWith('how') || lower.startsWith('explain')
      ? 'B'
      : 'A';
  return { class: cls, bm25Variants: [question] };
}
