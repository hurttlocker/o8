/**
 * Brain spend ledger + daily cap (2026-06-11 brain perf pass, Tier-1 guard).
 *
 * The brain's OpenRouter calls go straight to openrouter.ai — they never pass
 * through /api/v2/proxy/llm, so before this module they were invisible to the
 * app's own usage ledger and bounded by nothing but the account's credit
 * balance (the literal failure mode that motivated the 402 circuit breaker).
 *
 * Two jobs:
 *   1. Record every successful brain OpenRouter call into usage_logs
 *      (agentName 'cortex-qa') so spend is visible in the usage dashboard.
 *   2. Enforce a hard daily cap (O8_QA_OPENROUTER_DAILY_CAP_USD, default
 *      $0.50/day). When the cap is hit the OpenRouter tier throws and the
 *      cascade falls through to the free subscription/Flash tiers — the brain
 *      keeps answering, it just stops spending.
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

export function estimateCostUsd(model: string, usage: OpenRouterUsage): number {
  if (typeof usage.cost === 'number' && usage.cost >= 0) return usage.cost;
  const pricing = MODEL_PRICING_PER_TOKEN[model] ?? WORST_CASE_PRICING;
  return (usage.prompt_tokens ?? 0) * pricing.input + (usage.completion_tokens ?? 0) * pricing.output;
}

/**
 * Fire-and-forget: write one brain OpenRouter call into usage_logs. Never
 * throws — a ledger failure must not fail the answer that already succeeded.
 */
export function recordBrainOpenRouterSpend(model: string, usage: OpenRouterUsage): void {
  void (async () => {
    try {
      const { logUsage } = await import('@/lib/db/usage');
      logUsage({
        userId: null,
        model,
        provider: 'openrouter',
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        costUsd: estimateCostUsd(model, usage),
        agentName: BRAIN_AGENT_NAME,
      });
      spendTodayCache = null; // next cap check sees the new row
    } catch (err) {
      console.warn('[qa][brain-spend] ledger write failed:', err instanceof Error ? err.message : err);
    }
  })();
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
