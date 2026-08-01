/**
 * Brain spend ledger + daily cap (2026-06-11 brain perf pass, Tier-1 guard).
 *
 * The brain's direct provider calls do not pass through /api/v2/proxy/llm, so
 * without this module they are invisible to the app's usage ledger and bounded
 * only by the provider account's credit balance.
 *
 * Two jobs:
 *   1. Record every successful paid Brain call into usage_logs
 *      (agentName 'cortex-qa') so spend is visible in the usage dashboard.
 *   2. Enforce a hard daily cap (O8_QA_OPENROUTER_DAILY_CAP_USD, default
 *      $0.50/day). Existing Q&A callers may fall through to free tiers; palette
 *      Recall stops and renders nothing.
 *
 * Both paths fail-open on DB errors: a broken ledger must never take the
 * fast tier down with it (the cap is a spend guardrail, not a correctness
 * gate — and the breaker still bounds the failure-retry cost).
 */

import 'server-only';

/** USD per token (input, output) for the models in our OpenRouter chain. */
const MODEL_PRICING_PER_TOKEN: Record<string, { input: number; output: number }> = {
  'google/gemini-2.5-flash-lite': { input: 0.10e-6, output: 0.40e-6 },
  'openai/gpt-5.4-nano': { input: 0.20e-6, output: 1.25e-6 },
  'x-ai/grok-4.3': { input: 1.25e-6, output: 2.50e-6 },
};

/** Fallback pricing when the served model isn't in the table — assume the
 * priciest entry so the cap errs toward under-spend. */
const WORST_CASE_PRICING = { input: 1.25e-6, output: 2.50e-6 };

const BRAIN_AGENT_NAME = 'cortex-qa';
const DEFAULT_DAILY_CAP_USD = 0.5;

function dailyCapUsd(): number {
  const raw = Number(process.env.O8_QA_OPENROUTER_DAILY_CAP_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CAP_USD;
}

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenRouter returns spend in credits (USD) when `usage.include` is set. */
  cost?: number;
}

type BrainSpendProvider = 'google' | 'openrouter';

export function estimateCostUsd(model: string, usage: OpenRouterUsage): number {
  if (typeof usage.cost === 'number' && usage.cost >= 0) return usage.cost;
  const pricing = MODEL_PRICING_PER_TOKEN[model] ?? WORST_CASE_PRICING;
  return (usage.prompt_tokens ?? 0) * pricing.input + (usage.completion_tokens ?? 0) * pricing.output;
}

/**
 * Fire-and-forget: write one Brain provider call into usage_logs. Never
 * throws — a ledger failure must not fail the answer that already succeeded.
 */
function recordBrainSpend(
  provider: BrainSpendProvider,
  model: string,
  usage: OpenRouterUsage,
  requestType: 'chat' | 'embedding',
): void {
  // Invalidate the cap memo SYNCHRONOUSLY, before the async ledger write —
  // resetting it inside the async block left a window where every concurrent
  // ask kept reading the stale (lower) memo and sailed past the cap check
  // (review 2026-06-11). Nulling first forces the next check to re-sum from
  // the DB, which is the conservative direction for a spend guardrail.
  spendTodayCache = null;
  void (async () => {
    try {
      const { logUsage } = await import('@/lib/db/usage');
      logUsage({
        userId: null,
        model,
        provider,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        costUsd: estimateCostUsd(model, usage),
        agentName: BRAIN_AGENT_NAME,
        requestType,
      });
    } catch (err) {
      console.warn('[qa][brain-spend] ledger write failed:', err instanceof Error ? err.message : err);
    }
  })();
}

export function recordBrainOpenRouterSpend(model: string, usage: OpenRouterUsage): void {
  recordBrainSpend('openrouter', model, usage, 'chat');
}

/**
 * Gemini endpoints do not consistently return token usage. Estimate from text
 * length and charge the unknown-model worst-case rate so the daily cap remains
 * conservative. This puts embeddings and direct Flash calls in the same Brain
 * ledger as OpenRouter rather than leaving a paid side channel unmetered.
 */
export function recordBrainGeminiSpend(
  model: string,
  inputText: string,
  outputText = '',
  requestType: 'chat' | 'embedding' = 'chat',
): void {
  recordBrainSpend('google', model, {
    prompt_tokens: Math.max(1, Math.ceil(inputText.length / 4)),
    completion_tokens: outputText ? Math.ceil(outputText.length / 4) : 0,
  }, requestType);
}

// 60s memo so the cap check doesn't run a SQL sum on every single ask.
let spendTodayCache: { value: number; expiresAt: number } | null = null;
let lastCapWarnAt = 0;

async function getBrainSpendTodayUsd(): Promise<number> {
  if (spendTodayCache && Date.now() < spendTodayCache.expiresAt) {
    return spendTodayCache.value;
  }
  const { getSqlite } = await import('@/lib/db');
  // created_at is stored as a datetime string in both ISO-T and space-separated
  // shapes — substr(.,1,10) extracts YYYY-MM-DD from either.
  const row = getSqlite()
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM usage_logs
       WHERE agent_name = ? AND substr(created_at, 1, 10) = date('now', 'localtime')`,
    )
    .get(BRAIN_AGENT_NAME) as { total?: number } | undefined;
  const value = row?.total ?? 0;
  spendTodayCache = { value, expiresAt: Date.now() + 60_000 };
  return value;
}

/**
 * Throws when today's brain OpenRouter spend has reached the daily cap —
 * caller (the OpenRouter adapter) lets the error fall through the tier
 * cascade to the free providers. Fail-open on DB errors.
 */
export async function assertUnderBrainDailyCap(): Promise<void> {
  let spent: number;
  try {
    spent = await getBrainSpendTodayUsd();
  } catch {
    return; // ledger unavailable — don't take the tier down with it
  }
  const cap = dailyCapUsd();
  if (spent >= cap) {
    if (Date.now() - lastCapWarnAt > 10 * 60_000) {
      lastCapWarnAt = Date.now();
      console.warn(
        `[qa][brain-spend] daily OpenRouter cap reached ($${spent.toFixed(4)} >= $${cap.toFixed(2)}) — free tiers only until midnight`,
      );
    }
    throw new Error(
      `[qa][openrouter] daily spend cap reached ($${cap.toFixed(2)}) — falling through to free tiers`,
    );
  }
}

/** Test-only: clear the memoized spend value. */
export function resetBrainSpendCache(): void {
  spendTodayCache = null;
  lastCapWarnAt = 0;
}
