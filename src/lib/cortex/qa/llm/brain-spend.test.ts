/**
 * Spend-math tests for the brain OpenRouter ledger (Tier-1 guardrail,
 * 2026-06-11 brain perf pass).
 */

import { describe, expect, it } from 'vitest';

import { estimateCostUsd } from '@/lib/cortex/qa/llm/brain-spend';

describe('estimateCostUsd', () => {
  it('prefers the exact cost OpenRouter returns', () => {
    expect(estimateCostUsd('google/gemini-2.5-flash-lite', {
      prompt_tokens: 5_000,
      completion_tokens: 300,
      cost: 0.00123,
    })).toBe(0.00123);
  });

  it('falls back to the pricing table when cost is absent', () => {
    // 5k in @ $0.10/M + 300 out @ $0.40/M = $0.0005 + $0.00012
    const usd = estimateCostUsd('google/gemini-2.5-flash-lite', {
      prompt_tokens: 5_000,
      completion_tokens: 300,
    });
    expect(usd).toBeCloseTo(0.00062, 6);
  });

  it('uses worst-case pricing for unknown models (cap errs toward under-spend)', () => {
    // 1k in @ $1.25/M + 1k out @ $2.50/M = $0.00375
    const usd = estimateCostUsd('some/unknown-model', {
      prompt_tokens: 1_000,
      completion_tokens: 1_000,
    });
    expect(usd).toBeCloseTo(0.00375, 6);
  });

  it('treats missing token counts as zero', () => {
    expect(estimateCostUsd('google/gemini-2.5-flash-lite', {})).toBe(0);
  });
});
