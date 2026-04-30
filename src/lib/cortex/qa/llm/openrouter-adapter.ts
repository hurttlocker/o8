/**
 * OpenRouter adapter for the Cortex Q&A layer (epic #915 path-to-70 phase 1.7 v2).
 *
 * Paid HTTP safety net that sits between the two free CLI tiers and Gemini Flash:
 *
 *   composeClassA():  Haiku CLI → Codex CLI → OpenRouter → Flash → Sonnet CLI → heuristic
 *   classifyQuestion: Haiku CLI → Codex CLI → OpenRouter → Flash → heuristic
 *
 * Why this exact model order (empirically picked, not guessed):
 *   We bake-off'd 6 candidates against a 1-fact lookup + 5-fact spec prompt
 *   on 2026-04-30 (5 calls each, max_tokens=512). The data:
 *
 *     model                          p50 1fact   p50 5fact   quality   errors
 *     x-ai/grok-4.1-fast             2091 ms     5677 ms     2/3 + 3/3 0
 *     google/gemini-2.5-flash-lite   7019 ms     3950 ms     2/3 + 3/3 1 (503)
 *     openai/gpt-5-nano              10463 ms    12967 ms    0/3       1 (timeout)
 *     openai/gpt-5.4-nano            —           —           —         402 credit
 *     deepseek/deepseek-v4-pro       —           —           —         402 credit
 *     deepseek/deepseek-chat         —           —           —         402 credit
 *
 *   Grok 4.1 Fast is the unambiguous winner: fastest p50, tied highest
 *   quality, zero errors. Flash-Lite is the natural runner-up (tied quality,
 *   slower but proven). gpt-5-nano lands as third — cheap, but slow + empty
 *   on timeout.
 *
 *   We use OpenRouter's `models[]` parameter so a single HTTP request fails
 *   over to the next entry on provider error without an extra round-trip
 *   from our adapter.
 *
 * Why a separate adapter (vs. extending haiku-adapter):
 *   - HTTP, not CLI: no shell probing, no spawn cost. ~1s cold-start.
 *   - The chain is hardcoded — tier 3 between two free CLIs (Haiku, Codex)
 *     and Flash. Keeps each adapter single-responsibility.
 */

import 'server-only';

// ── Public API ───────────────────────────────────────────────────────────────

export interface CallOpenRouterOptions {
  /** Override the primary model. Defaults to OPENROUTER_PRIMARY_MODEL. */
  model?: string;
  /** Override the in-call fallback list. Defaults to OPENROUTER_FALLBACK_MODELS. */
  fallbackModels?: string[];
  /** HTTP timeout. Default 10s — Grok 4.1 Fast 5-fact p50 was 5.7s in the
   *  bake-off, so 8s would cut ~30% of long answers; 10s gives runway. */
  timeoutMs?: number;
}

/**
 * Primary OpenRouter model — empirically picked from the 2026-04-30 bake-off:
 * 2.1s p50 on 1-fact, 5.7s on 5-fact, 2/3 + 3/3 quality, 0 errors across 10
 * calls. Cheaper than gpt-5.4-nano ($0.20/$0.50 per M vs $0.20/$1.25).
 */
export const OPENROUTER_PRIMARY_MODEL = 'x-ai/grok-4.1-fast';

/**
 * In-call fallback chain. OpenRouter's `models[]` parameter auto-fails over
 * to the next entry on provider error, so our adapter doesn't pay for the
 * extra round-trip.
 *
 * Order picked from the same bake-off:
 *   1. google/gemini-2.5-flash-lite — runner-up (tied quality, 1 503 in 10)
 *   2. openai/gpt-5-nano            — third (cheap, slow but proven)
 */
export const OPENROUTER_FALLBACK_MODELS = ['google/gemini-2.5-flash-lite', 'openai/gpt-5-nano'];

/**
 * Call OpenRouter chat completions with `prompt` as a single user message.
 *
 * Throws on:
 *   - OPENROUTER_API_KEY missing (caller should fall through to next tier)
 *   - HTTP timeout
 *   - Non-2xx response
 *   - Empty content
 *
 * Caller is responsible for the fallback chain (Haiku CLI ran before us;
 * Gemini Flash / heuristic come after).
 */
export async function callOpenRouter(
  prompt: string,
  opts: CallOpenRouterOptions = {},
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('[qa][openrouter] OPENROUTER_API_KEY missing');
  }

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const primary = opts.model ?? OPENROUTER_PRIMARY_MODEL;
  const fallbacks = opts.fallbackModels ?? OPENROUTER_FALLBACK_MODELS;

  // OpenRouter accepts `model` (primary) + `models[]` (in-call fallback).
  // Including the primary in `models[]` is harmless but redundant; we keep
  // them separate so the response's actual-served model is unambiguous.
  const body = {
    model: primary,
    models: fallbacks,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 512,
  };

  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        // OpenRouter recommends these for analytics; harmless if dropped.
        'HTTP-Referer': 'https://o8.run',
        'X-Title': 'o8 Cortex Q&A',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[qa][openrouter] fetch failed: ${message}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`[qa][openrouter] HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
  };

  const text = json.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) {
    throw new Error('[qa][openrouter] empty response content');
  }

  return text;
}

/**
 * Resolve which model OpenRouter actually served. Useful for the
 * "[qa][composer-A] resolved via openrouter:<model>" log line.
 *
 * Falls back to the primary model name when the response shape is unexpected.
 */
export function describeOpenRouterModel(servedModel: string | undefined): string {
  return servedModel?.trim() ? servedModel : OPENROUTER_PRIMARY_MODEL;
}
