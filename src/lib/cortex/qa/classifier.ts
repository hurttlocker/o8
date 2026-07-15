/**
 * Question classifier for the Cortex Q&A composer (epic #915 sub-2,
 * provider chain rewired in path-to-70 phase 1.7 v2,
 * fast-path + cache shipped in #1115).
 *
 * Five-tier provider chain — all return the same { class, bm25Variants } shape:
 *   1. OpenRouter (flash-lite + gpt-5.4-nano + grok-4.3 fallback) — paid HTTP, ~500ms
 *   2. Gemini Flash JSON-mode (free-tier HTTP, ~0.5-1.5s — promoted above the
 *      CLI tiers 2026-06-11: HTTP beats a 6-8s process bootstrap)
 *   3. Claude Haiku CLI       (free for Claude Max users — skipped unless in-app orchestrator ON)
 *   4. Codex CLI (gpt-5.5)    (free for ChatGPT Plus / Codex sub users)
 *   5. Heuristic fallback     (lexical "why/how/explain" → Class B)
 *
 * Why OpenRouter is tier 1 now (changed in #1115): the CLI tiers spend 15-30s
 * on bootstrap alone, making the classifier the dominant cost in the Q&A
 * pipeline (43s classify vs 500ms retrieve). OpenRouter (flash-lite primary
 * since grok-4.1-fast was deprecated 2026-06-11) is empirically <500ms p50
 * and matches CLI quality on the 6-question bake-off.
 * The CLI tiers remain available as fallbacks when OpenRouter is unreachable
 * (no key, HTTP error, timeout).
 *
 * Cache: 60s in-process cache keyed by sha256(question). Identical questions
 * within 60s skip the LLM call entirely — sub-millisecond hit path.
 *
 * Class A = lookup: "who/when/where/what" — expects a 1-2 fact answer
 * Class B = reasoning: "why/how/explain" — expects multi-fact composition
 *
 * BM25 variants are passed directly to `retrieveAll()` so the FTS5 retriever
 * can search with synonym/phrasing expansion.
 */

import 'server-only';

import { createHash } from 'node:crypto';

import { CODEX_DEFAULT_MODEL, callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { callHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { callOpenRouter, OPENROUTER_PRIMARY_MODEL } from '@/lib/cortex/qa/llm/openrouter-adapter';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';

export type QuestionClass = 'A' | 'B';

export interface ClassifierResult {
  class: QuestionClass;
  bm25Variants: string[];
}

// ── In-process classifier cache ──────────────────────────────────────────────
//
// Identical questions within the TTL skip every LLM call. The cache is keyed
// by sha256(question) — repoPath/projectId don't influence classification
// (Class A/B + BM25 variants are properties of the question, not the scope).
//
// TTL is short (60s) so a corrected classifier ships fast in the dev loop;
// production cold cache is the only path that pays for the LLM call.

const CLASSIFIER_CACHE_TTL_MS = 60_000;
const CLASSIFIER_CACHE_MAX = 500;

interface ClassifierCacheEntry {
  result: ClassifierResult;
  expiresAt: number;
}

const classifierCache = new Map<string, ClassifierCacheEntry>();

function classifierCacheKey(question: string): string {
  return createHash('sha256').update(question.trim().toLowerCase()).digest('hex');
}

function getCachedClassification(question: string): ClassifierResult | null {
  const entry = classifierCache.get(classifierCacheKey(question));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    classifierCache.delete(classifierCacheKey(question));
    return null;
  }
  return entry.result;
}

function setCachedClassification(question: string, result: ClassifierResult): void {
  classifierCache.set(classifierCacheKey(question), {
    result,
    expiresAt: Date.now() + CLASSIFIER_CACHE_TTL_MS,
  });
  // Lazy eviction of expired entries when the cache grows large.
  if (classifierCache.size > CLASSIFIER_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of classifierCache) {
      if (now > v.expiresAt) classifierCache.delete(k);
    }
  }
}

/** Test-only: clear the classifier cache. */
export function resetClassifierCache(): void {
  classifierCache.clear();
}

const CLASSIFIER_PROMPT = `Classify the engineering question. Return ONLY a single JSON object — no prose, no markdown fences, no \`\`\` blocks, no commentary before or after.
The very first character of your response MUST be \`{\` and the last MUST be \`}\`.
Output exactly: { "class": "A" | "B", "bm25_variants": ["v1","v2","v3"] }
Class A = lookup ("who/when/where/what"), 1-2 fact answer, deterministic
Class B = reasoning ("why/how/explain"), multi-fact composition required
bm25_variants: 3-5 alternate phrasings using synonyms and rephrasings of the question`;

/**
 * Classify the question with a 5-tier provider chain:
 *   1. OpenRouter (flash-lite w/ gpt-5.4-nano + grok-4.3 fallback) — paid HTTP, ~500ms
 *   2. Gemini Flash (JSON-mode, free-tier HTTP ~0.5-1.5s — ahead of CLI bootstraps)
 *   3. Claude Haiku CLI (Claude Max sub — free, ~6-12s, only when in-app orchestrator toggle ON)
 *   4. Codex CLI gpt-5.5 (ChatGPT Plus sub — free, ~15-30s, fallback when HTTP tiers unreachable)
 *   5. Heuristic fallback (lexical "why/how/explain" → Class B)
 *
 * Cache: 60s in-process by sha256(question). Sub-ms hit path.
 *
 * Returns the classification + BM25 variants. Never throws; on full failure
 * returns the heuristic Class B so retrieval still gets at least one variant.
 */
export async function classifyQuestion(question: string): Promise<ClassifierResult> {
  // ── Cache hit path (sub-millisecond) ───────────────────────────────────
  const cached = getCachedClassification(question);
  if (cached) {
    return cached;
  }

  const prompt = `${CLASSIFIER_PROMPT}\n\nQuestion: ${question}`;
  // O8_EVAL_MODE=1 routes the Anthropic tiers through the REPL one-shot
  // adapters (subscription-billed, #1124) instead of OpenRouter's paid
  // `anthropic/claude-...` models. The REPL path also skips the OpenRouter
  // round-trip, so eval runs are cheaper AND closer to what production users
  // hit on the Class B path.
  const evalMode = process.env.O8_EVAL_MODE === '1' || process.env.O8_EVAL_MODE === 'true';

  // Eval-mode tier 0: Sonnet 4.6 via the REPL adapter — matches the composer's
  // primary model so classifier + composer use the same reasoning quality.
  // BM25 variants from Sonnet are reliably better than grok-4.1-fast.
  if (evalMode) {
    const sonnetResult = await trySonnetRepl(prompt, question);
    if (sonnetResult) {
      console.info('[qa][classifier] resolved via sonnet-repl (eval tier 0)');
      setCachedClassification(question, sonnetResult);
      return sonnetResult;
    }
    // Eval-mode tier 0b: Haiku 4.5 via the REPL adapter as cheap fallback.
    const haikuReplResult = await tryHaiku(prompt, question);
    if (haikuReplResult) {
      console.info('[qa][classifier] resolved via haiku-repl (eval tier 0b)');
      setCachedClassification(question, haikuReplResult);
      return haikuReplResult;
    }
  }

  // Tier 1: OpenRouter (HTTP, ~500ms) — promoted to first in #1115 because the
  // CLI tiers spend 15-30s on bootstrap alone and dominate interactive Q&A latency.
  // The CLI tiers remain as fallbacks below.
  const openrouterResult = await tryOpenRouter(prompt, question);
  if (openrouterResult) {
    console.info(`[qa][classifier] resolved via openrouter:${OPENROUTER_PRIMARY_MODEL} (tier 1)`);
    setCachedClassification(question, openrouterResult);
    return openrouterResult;
  }

  // Tier 2: Gemini Flash direct (when a Google AI key is present). Promoted
  // ABOVE the CLI tiers (2026-06-11 brain perf pass): when OpenRouter is
  // unreachable, Flash answers in ~0.5-1.5s over HTTP while a CLI tier pays
  // 6-8s of `claude`/`codex` process bootstrap before the model even runs —
  // the exact disease #1115 cured for OpenRouter. The 503-churn worry that
  // originally demoted Flash is handled by falling through to the CLI tiers
  // below on any failure.
  const apiKey = process.env.GOOGLE_AI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (apiKey) {
    const flashResult = await tryFlash(question, apiKey);
    if (flashResult) {
      console.info('[qa][classifier] resolved via flash (tier 2)');
      setCachedClassification(question, flashResult);
      return flashResult;
    }
  }

  // CLI tier ordering depends on the Brain's own `brainUseClaudeCli` setting
  // (epic #1044; decoupled from the orchestrator toggle 2026-06-22):
  //   - OFF → Codex is the only CLI tier (Haiku would throw — no Claude sub).
  //   - ON  → Haiku first, then Codex.
  let brainCliOn = false;
  if (!evalMode) {
    try {
      const { resolveBrainUseClaudeCliSync } = await import('@/lib/operator/defaults');
      brainCliOn = resolveBrainUseClaudeCliSync();
    } catch {
      brainCliOn = false;
    }
  }

  // Tier 3 (only when brainUseClaudeCli ON): Haiku CLI — free for Claude sub users.
  if (!evalMode && brainCliOn) {
    const haikuResult = await tryHaiku(prompt, question);
    if (haikuResult) {
      console.info('[qa][classifier] resolved via haiku-cli (tier 3 fallback)');
      setCachedClassification(question, haikuResult);
      return haikuResult;
    }
  }

  // Tier 4: Codex CLI — free for ChatGPT Plus / Codex sub users. Always tried
  // when not eval-mode and the HTTP tiers failed.
  if (!evalMode) {
    const codexResult = await tryCodex(prompt, question);
    if (codexResult) {
      console.info(
        `[qa][classifier] resolved via codex-cli:${CODEX_DEFAULT_MODEL} (tier 4 fallback)`,
      );
      setCachedClassification(question, codexResult);
      return codexResult;
    }
  }

  // Tier 5: heuristic. Don't cache — we want subsequent calls to retry the LLM
  // tiers in case they were transiently down.
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

/**
 * Eval-mode tier 0: Sonnet 4.6 via the REPL one-shot adapter. Used in place
 * of `tryOpenRouter(prompt, question, 'anthropic/claude-sonnet-5')` post-#1124
 * so eval runs go through the subscription pool instead of paid OpenRouter.
 */
async function trySonnetRepl(prompt: string, question: string): Promise<ClassifierResult | null> {
  try {
    const result = await callSonnet({
      system: 'You are a strict classifier. Return only the JSON object specified.',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      // Eval mode tolerates the longer Sonnet bootstrap; downstream timeout in
      // the runner already caps overall wall time.
      timeoutMs: 120_000,
    });
    if (result.tier === 'flash') {
      // Adapter degraded back to Flash — that means no Claude path was
      // available. Return null so the caller falls through to grok-4.1-fast.
      return null;
    }
    return parseClassifierJson(result.text, question);
  } catch (err) {
    console.warn('[qa][classifier] Sonnet REPL failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 2: Codex CLI. Free for ChatGPT Plus / Codex sub users. */
async function tryCodex(prompt: string, question: string): Promise<ClassifierResult | null> {
  try {
    // 30s — Codex bootstrap is ~15s for trivial prompts (verified live with gpt-5.5).
    // Larger ceiling than Haiku because the model takes longer to reason.
    const text = await callCodex(prompt, { timeoutMs: 30_000 });
    return parseClassifierJson(text, question);
  } catch (err) {
    console.warn('[qa][classifier] Codex CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 3: OpenRouter. HTTP call to grok-4.1-fast with flash-lite + gpt-5.4-nano in-call fallback.
 * Optional `model` override routes to a specific model instead of the primary
 * (used by the eval-mode Haiku-4.5 tier). */
async function tryOpenRouter(prompt: string, question: string, model?: string): Promise<ClassifierResult | null> {
  try {
    // 25s — bumped from 10s alongside composer's bump to handle multi-row
    // prompts under load. Classifier prompts are small but grok-4.1-fast
    // occasionally takes 8-12s when OpenRouter routes through a slow upstream.
    const text = await callOpenRouter(prompt, { timeoutMs: 25_000, model });
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
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
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
