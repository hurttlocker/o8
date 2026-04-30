/**
 * Question classifier for the Cortex Q&A composer (epic #915 sub-2,
 * provider chain rewired in path-to-70 phase 1.7 v2).
 *
 * Five-tier provider chain — all return the same { class, bm25Variants } shape:
 *   1. Claude Haiku CLI       (free for Claude Max users — primary)
 *   2. Codex CLI (gpt-5.4)    (free for ChatGPT Plus / Codex sub users)
 *   3. OpenRouter (grok-4.1-fast + flash-lite + gpt-5-nano fallback) — paid HTTP
 *   4. Gemini Flash JSON-mode (last LLM tier; demoted because of recent 503s)
 *   5. Heuristic fallback     (lexical "why/how/explain" → Class B)
 *
 * Latency tradeoff is intentional: tiers 1 + 2 are ~15s each but FREE for
 * users with the corresponding subscription. Two free paths beat one fast
 * paid path. OpenRouter (~1s) is the safety net when neither sub is active.
 *
 * Class A = lookup: "who/when/where/what" — expects a 1-2 fact answer
 * Class B = reasoning: "why/how/explain" — expects multi-fact composition
 *
 * BM25 variants are passed directly to `retrieveAll()` so the FTS5 retriever
 * can search with synonym/phrasing expansion.
 */

import 'server-only';

import { CODEX_DEFAULT_MODEL, callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { callHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { callOpenRouter, OPENROUTER_PRIMARY_MODEL } from '@/lib/cortex/qa/llm/openrouter-adapter';

export type QuestionClass = 'A' | 'B';

export interface ClassifierResult {
  class: QuestionClass;
  bm25Variants: string[];
}

const CLASSIFIER_PROMPT = `Classify the engineering question. Return ONLY a single JSON object — no prose, no markdown fences, no \`\`\` blocks, no commentary before or after.
The very first character of your response MUST be \`{\` and the last MUST be \`}\`.
Output exactly: { "class": "A" | "B", "bm25_variants": ["v1","v2","v3"] }
Class A = lookup ("who/when/where/what"), 1-2 fact answer, deterministic
Class B = reasoning ("why/how/explain"), multi-fact composition required
bm25_variants: 3-5 alternate phrasings using synonyms and rephrasings of the question`;

/**
 * Classify the question with a 5-tier provider chain:
 *   1. Claude Haiku CLI (Claude Max subscription — no per-token cost, primary)
 *   2. Codex CLI gpt-5.4 (ChatGPT Plus / Codex subscription — also free)
 *   3. OpenRouter (grok-4.1-fast w/ flash-lite + gpt-5-nano fallback) — paid HTTP
 *   4. Gemini Flash (JSON-mode; demoted because of recent 503s)
 *   5. Heuristic fallback (lexical "why/how/explain" → Class B)
 *
 * Returns the classification + BM25 variants. Never throws; on full failure
 * returns the heuristic Class B so retrieval still gets at least one variant.
 */
export async function classifyQuestion(question: string): Promise<ClassifierResult> {
  const prompt = `${CLASSIFIER_PROMPT}\n\nQuestion: ${question}`;

  // Tier 1: Haiku CLI (free for Claude Max users).
  const haikuResult = await tryHaiku(prompt, question);
  if (haikuResult) {
    console.info('[qa][classifier] resolved via haiku-cli');
    return haikuResult;
  }

  // Tier 2: Codex CLI (free for ChatGPT Plus / Codex sub users).
  const codexResult = await tryCodex(prompt, question);
  if (codexResult) {
    console.info(`[qa][classifier] resolved via codex-cli:${CODEX_DEFAULT_MODEL}`);
    return codexResult;
  }

  // Tier 3: OpenRouter (fast, paid — safety net when both CLIs unavailable).
  const openrouterResult = await tryOpenRouter(prompt, question);
  if (openrouterResult) {
    console.info(`[qa][classifier] resolved via openrouter:${OPENROUTER_PRIMARY_MODEL}`);
    return openrouterResult;
  }

  // Tier 4: Flash (when a Google AI key is present).
  const apiKey = process.env.GOOGLE_AI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (apiKey) {
    const flashResult = await tryFlash(question, apiKey);
    if (flashResult) {
      console.info('[qa][classifier] resolved via flash');
      return flashResult;
    }
  }

  // Tier 5: heuristic.
  console.info('[qa][classifier] resolved via heuristic');
  return fallback(question);
}

/** Tier 1: Haiku CLI. Returns null on any failure so caller can chain. */
async function tryHaiku(prompt: string, question: string): Promise<ClassifierResult | null> {
  try {
    // 12s — Haiku CLI bootstrap (login-shell + node start) takes ~6-8s before
    // the model even runs. This is the primary tier so the longer ceiling
    // is worth it; Codex CLI / OpenRouter / Flash are the fallbacks.
    const text = await callHaiku(prompt, { timeoutMs: 12_000 });
    return parseClassifierJson(text, question);
  } catch (err) {
    console.warn('[qa][classifier] Haiku CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 2: Codex CLI. Free for ChatGPT Plus / Codex sub users. */
async function tryCodex(prompt: string, question: string): Promise<ClassifierResult | null> {
  try {
    // 30s — Codex bootstrap is ~15s for trivial prompts (verified live with gpt-5.4).
    // Larger ceiling than Haiku because the model takes longer to reason.
    const text = await callCodex(prompt, { timeoutMs: 30_000 });
    return parseClassifierJson(text, question);
  } catch (err) {
    console.warn('[qa][classifier] Codex CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 3: OpenRouter. HTTP call to grok-4.1-fast with flash-lite + gpt-5-nano in-call fallback. */
async function tryOpenRouter(prompt: string, question: string): Promise<ClassifierResult | null> {
  try {
    // 10s — Grok 4.1 Fast 5-fact p50 was 5.7s in the bake-off; 8s would
    // truncate ~30% of long answers, 10s gives headroom.
    const text = await callOpenRouter(prompt, { timeoutMs: 10_000 });
    return parseClassifierJson(text, question);
  } catch (err) {
    console.warn('[qa][classifier] OpenRouter failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 4: Flash JSON-mode call. Returns null on any failure so caller can chain. */
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
      console.warn(`[qa][classifier] Flash API error ${res.status} — falling through to heuristic`);
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

/**
 * Parse a classifier JSON response (any tier).
 *
 * CLI-backed providers (Haiku, Codex, OpenRouter) sometimes wrap JSON in
 * markdown fences or sandwich it between preamble/postamble prose despite
 * being told not to. The parser tries, in order:
 *   1. closed ```json ... ``` block
 *   2. unclosed ```json ... (no trailing fence — Codex sometimes does this)
 *   3. greedy { ... } match anywhere in the response
 *
 * Returns null if the payload still can't be coerced — caller falls through.
 */
function parseClassifierJson(rawText: string, question: string): ClassifierResult | null {
  let text = rawText.trim();

  // 1. Closed code fence — ```json {...} ``` or ``` {...} ```
  const closedFence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (closedFence) {
    text = closedFence[1].trim();
  } else {
    // 2. Unclosed fence — Codex sometimes drops the trailing ```
    const openFence = text.match(/```(?:json)?\s*([\s\S]*)$/i);
    if (openFence) {
      text = openFence[1].trim();
    }
    // 3. Extract first {...} (handles preamble + postamble prose)
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

/** Safe fallback when all LLM tiers are unavailable or return garbage. */
function fallback(question: string): ClassifierResult {
  // Heuristic: questions starting with "why" / "how" / "explain" → Class B.
  const lower = question.trim().toLowerCase();
  const cls: QuestionClass =
    lower.startsWith('why') || lower.startsWith('how') || lower.startsWith('explain')
      ? 'B'
      : 'A';
  return { class: cls, bm25Variants: [question] };
}
