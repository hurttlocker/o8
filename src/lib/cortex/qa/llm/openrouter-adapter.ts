/**
 * OpenRouter adapter for the Cortex Q&A layer (epic #915 path-to-70 phase 1.7 v2).
 *
 * Paid HTTP safety net that sits between the two free CLI tiers and Gemini Flash:
 *
 *   composeClassA():  Haiku CLI → Codex CLI → OpenRouter → Flash → Sonnet CLI → heuristic
 *   classifyQuestion: Haiku CLI → Codex CLI → OpenRouter → Flash → heuristic
 *
 * Why this exact model order (empirically picked, not guessed):
 *   We re-baked-off all 6 candidates with a credited account on 2026-04-30
 *   (phase 1.7.1 rerun — the 3 deepseek/gpt-5.4-nano rows that 402'd in the
 *   original bake-off are now measured). 5 calls each on a 1-fact lookup +
 *   5-fact spec prompt, max_tokens=512, temperature=0. The data:
 *
 *     model                          p50 1f   p95 1f   p50 5f   p95 5f   quality   errors
 *     x-ai/grok-4.1-fast             148 ms   189 ms   124 ms   307 ms   3/3 + 3/3 0
 *     google/gemini-2.5-flash-lite   505 ms   535 ms   471 ms   537 ms   3/3 + 3/3 0
 *     openai/gpt-5.4-nano            479 ms   597 ms   386 ms   491 ms   3/3 + 3/3 0
 *     deepseek/deepseek-chat         148 ms  1455 ms   204 ms   988 ms   3/3 + 3/3 0
 *     deepseek/deepseek-v4-pro      1575 ms  7067 ms  1805 ms  3007 ms   3/3 + 3/3 0
 *     openai/gpt-5-nano              397 ms   458 ms   —        —        3/3 + 0/3 8 (empty content)
 *
 *   Five models tied on quality (6/6 — every one enumerated all 5 facts and
 *   cited every handle on the 5-fact prompt). The tiebreaker is latency p95
 *   sum, where Grok 4.1 Fast wins decisively (496 ms vs runners-up 1072+ ms),
 *   followed by Flash-Lite, then gpt-5.4-nano. gpt-5-nano is dropped — it
 *   returned empty content on 8 of 10 calls (provider-side issue, not noise),
 *   so it's net negative as a fallback. DeepSeek-chat has spiky p95 1.5s
 *   (good but inconsistent); deepseek-v4-pro has 7s p95 1-fact and 5x the
 *   price of Grok — both cost more on the latency budget than they save.
 *
 *   Pricing (per M tokens, OpenRouter list 2026-04-30):
 *     grok-4.1-fast            $0.20 / $0.50
 *     gemini-2.5-flash-lite    $0.10 / $0.40 (cheapest)
 *     gpt-5.4-nano             $0.20 / $1.25
 *     deepseek-chat            $0.32 / $0.89
 *     deepseek-v4-pro          $0.435 / $0.87
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

import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';

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
 * Primary OpenRouter model — empirically held from the 2026-04-30 phase 1.7.1
 * rerun (credited account, all 6 candidates measured): 148 ms p50 1-fact,
 * 124 ms p50 5-fact, 6/6 quality, 0 errors across 10 calls. Lowest p95-sum
 * (496 ms) of all 5 quality-tied models. $0.20/$0.50 per M tokens.
 */
export const OPENROUTER_PRIMARY_MODEL = 'x-ai/grok-4.1-fast';

/**
 * In-call fallback chain. OpenRouter's `models[]` parameter auto-fails over
 * to the next entry on provider error, so our adapter doesn't pay for the
 * extra round-trip.
 *
 * Order picked from the phase 1.7.1 rerun (all 6/6 quality, ranked by p95-sum):
 *   1. google/gemini-2.5-flash-lite — p95 sum 1072 ms, $0.10/$0.40 (cheapest)
 *   2. openai/gpt-5.4-nano          — p95 sum 1088 ms, $0.20/$1.25
 *
 * Dropped from the prior chain: openai/gpt-5-nano returned empty content on
 * 8 of 10 calls in the rerun (provider-side issue), so promoting it as a
 * fallback hurts more than it helps. gpt-5.4-nano was previously unreachable
 * (402'd) and now earns its slot.
 */
export const OPENROUTER_FALLBACK_MODELS = ['google/gemini-2.5-flash-lite', 'openai/gpt-5.4-nano'];

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
  // BYOK (#960): resolve from stored user key first, then process.env.
  // Smoke path always has process.env.OPENROUTER_API_KEY set, so it
  // resolves immediately without hitting the file.
  const apiKey = await resolveOpenRouterKey();
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
