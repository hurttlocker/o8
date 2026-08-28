/**
 * Spend-math tests for the brain OpenRouter ledger (Tier-1 guardrail,
 * 2026-06-11 brain perf pass).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-brain-spend-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const {
  assertUnderBrainDailyCap,
  estimateCostUsd,
  resetBrainSpendCache,
  withBrainRetrievalUsage,
} = await import('@/lib/cortex/qa/llm/brain-spend');
const { getSqlite } = await import('@/lib/db');
const { logUsage } = await import('@/lib/db/usage');

afterAll(() => {
  delete process.env.O8_QA_OPENROUTER_DAILY_CAP_USD;
  rmSync(dataDir, { recursive: true, force: true });
});

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

  it('records one zero-dollar subscription retrieval without changing the daily cap sum', async () => {
    process.env.O8_QA_OPENROUTER_DAILY_CAP_USD = '0.5';
    logUsage({
      userId: null,
      model: 'paid-brain-model',
      provider: 'openrouter',
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.49,
      agentName: 'cortex-qa',
      role: 'retrieval',
    });
    const spendBefore = getSqlite().prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_logs WHERE agent_name = 'cortex-qa'",
    ).get() as { total: number };

    resetBrainSpendCache();
    await expect(assertUnderBrainDailyCap()).resolves.toBeUndefined();
    await withBrainRetrievalUsage(
      'Which migration owns the current schema?',
      { packetId: 'packet-brain-spend' },
      async () => ({ answer: 'Schema v57 owns cost attribution.' }),
      (result) => result.answer,
    );

    const rows = getSqlite().prepare(`
      SELECT role, packet_id, input_tokens, output_tokens, cost_usd, metadata_json
      FROM usage_logs WHERE model = 'cortex-qa-request'
    `).all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([expect.objectContaining({
      role: 'retrieval',
      packet_id: 'packet-brain-spend',
      cost_usd: 0,
    })]);
    expect(JSON.parse(String(rows[0]?.metadata_json))).toMatchObject({
      estimated: true,
      source: 'chars_per_four',
    });
    const spendAfter = getSqlite().prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_logs WHERE agent_name = 'cortex-qa'",
    ).get() as { total: number };
    expect(spendAfter.total).toBe(spendBefore.total);
    resetBrainSpendCache();
    await expect(assertUnderBrainDailyCap()).resolves.toBeUndefined();
  });
});
