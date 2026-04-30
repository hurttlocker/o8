/**
 * OpenRouter adapter for the Cortex Q&A layer (epic #915 path-to-70 phase 1.7).
 *
 * Cheap-reasoning fallback that sits between Haiku CLI and Gemini Flash:
 *
 *   composeClassA():  Haiku CLI → OpenRouter → Flash → Sonnet CLI → heuristic
 *   classifyQuestion: Haiku CLI → OpenRouter → Flash → heuristic
 *
 * Why OpenRouter:
 *   - Uses OpenRouter's `models[]` parameter for in-call fallback so a single
 *     HTTP request degrades GPT-5.4 Nano → GPT-5 Nano without extra round-trips.
 *   - GPT-5.4 Nano is the newest reasoning-tuned cheap model on OR as of
 *     2026-04 ($0.20/$1.25 per M, 400K ctx). GPT-5 Nano is the proven
 *     fallback ($0.05/$0.40 per M).
 *
 * Why a separate adapter (vs. extending haiku-adapter):
 *   - HTTP, not CLI: no shell probing, no spawn cost. Subsecond cold-start.
 *   - The chain is hardcoded — tier 2 between Haiku CLI (free, slower) and
 *     Flash (free, also fast). Keeps each adapter single-responsibility.
 */

import 'server-only';

// ── Public API ───────────────────────────────────────────────────────────────

export interface CallOpenRouterOptions {
  /** Override the primary model. Defaults to OPENROUTER_PRIMARY_MODEL. */
  model?: string;
  /** Override the in-call fallback list. Defaults to OPENROUTER_FALLBACK_MODELS. */
  fallbackModels?: string[];
  /** HTTP timeout. Default 8s — Class A fast lookup budget. */
  timeoutMs?: number;
}

/**
 * Primary OpenRouter model: newest GPT in the cheap tier as of 2026-04.
 * Bias toward newest + best for quick lookup; cost is a tiebreaker.
 */
export const OPENROUTER_PRIMARY_MODEL = 'openai/gpt-5.4-nano';

/**
 * In-call fallback chain. OpenRouter's `models[]` parameter auto-fails over
 * to the next entry on provider error, so our adapter doesn't pay for the
 * extra round-trip.
 */
export const OPENROUTER_FALLBACK_MODELS = ['openai/gpt-5-nano', 'openai/gpt-4.1-mini'];

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

  const timeoutMs = opts.timeoutMs ?? 8_000;
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
