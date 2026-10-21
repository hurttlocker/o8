/**
 * #3481: o8's own OpenRouter work, from the Pi route transport's receipts to
 * the API route the settings card reads. Every call goes to a fixture fetch.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Context } from '@earendil-works/pi-ai/compat';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-openrouter-work-'));
const previousEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
};
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY = 'fixture-openrouter-key';

const { createPiOpenRouterRouteTransport, recordPiOpenRouterReceipt } = await import('@/lib/pi/openrouter-choice');
const { openRouterPiModel, OPENROUTER_NO_CREDIT_TEXT } = await import('@/lib/pi/sdk/openrouter-transport');
const { getSqlite } = await import('@/lib/db');
const { logUsage } = await import('@/lib/db/usage');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { GET } = await import('@/app/api/v2/keys/openrouter/work/route');
const { NextRequest } = await import('next/server');

afterAll(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const MODEL = 'deepseek/deepseek-v4.1-flash';
const pricing = { inputPerMillion: 0.3, outputPerMillion: 1.2 };
const route = {
  carrier: 'openrouter' as const,
  model: openRouterPiModel(MODEL, pricing, 64_000),
  label: `${MODEL} (OpenRouter)`,
  choice: `openrouter/${MODEL}`,
  pricing,
};
const context = { messages: [{ role: 'user', content: 'Say hello.', timestamp: 1 }] } as unknown as Context;

function completion(generationId: string, cost: number): Response {
  const chunks = [
    { id: generationId, object: 'chat.completion.chunk', created: 1, model: MODEL,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello.' }, finish_reason: null }] },
    { id: generationId, object: 'chat.completion.chunk', created: 1, model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost } },
  ];
  const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function call(role: 'orchestrator' | 'worker', response: () => Response) {
  const receipts: Array<{ generationId: string | null; status: string; costUsd: number | null }> = [];
  const { transport } = createPiOpenRouterRouteTransport(route, {
    ceilingUsd: 0.25,
    attribution: { role, agentName: 'pi', sessionKey: `${role}-session`, packetId: role === 'worker' ? 'pkt-fixture' : null },
    fetch: (async () => response()) as unknown as typeof fetch,
    onReceipt: receipt => receipts.push(receipt),
  });
  const errors: string[] = [];
  for await (const event of transport(context, new AbortController().signal)) {
    if (event.type === 'error') errors.push(event.error.errorMessage ?? '');
  }
  return { receipts, errors };
}

async function readWork() {
  const request = new NextRequest('http://127.0.0.1/api/v2/keys/openrouter/work?days=30', {
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  });
  const response = await GET(request);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain('fixture-openrouter-key');
  return JSON.parse(text) as {
    scope: string;
    duplicateRows: number;
    totals: Record<string, number>;
    bySource: Array<{ key: string } & Record<string, number>>;
  };
}

function generationRows(generationId: string): number {
  return (getSqlite().prepare(
    "SELECT COUNT(*) AS n FROM usage_logs WHERE provider = 'openrouter' AND json_extract(metadata_json, '$.generationId') = ?",
  ).get(generationId) as { n: number }).n;
}

describe('OpenRouter work run by o8', () => {
  it('reports provider cost, estimates, unlabeled rows and unknown cost separately, and counts a generation once', async () => {
    const lead = await call('orchestrator', () => completion('gen-lead-1', 0.001));
    expect(lead.errors).toEqual([]);

    const noCredit = await call('orchestrator', () => new Response('{"error":{"message":"raw provider detail"}}', { status: 402 }));
    expect(noCredit.errors).toEqual([OPENROUTER_NO_CREDIT_TEXT]);
    expect(noCredit.receipts[0]).toMatchObject({ status: 'failed', costUsd: null });

    const worker = await call('worker', () => completion('gen-worker-1', 0.002));
    expect(worker.errors).toEqual([]);

    // A replayed receipt for the same generation is not a second charge.
    recordPiOpenRouterReceipt({ ...worker.receipts[0], status: 'completed' } as never,
      { role: 'worker', agentName: 'pi', sessionKey: 'worker-session', packetId: 'pkt-fixture' });
    expect(generationRows('gen-worker-1')).toBe(1);

    logUsage({ userId: null, model: 'google/gemini-2.5-flash-lite', provider: 'openrouter', inputTokens: 50, outputTokens: 5,
      costUsd: 0.0005, agentName: 'cortex-brain', role: 'retrieval', requestType: 'completion', metadata: { costSource: 'estimate' } });
    logUsage({ userId: null, model: 'openai/gpt-5.5-mini', provider: 'openrouter', inputTokens: 40, outputTokens: 4,
      costUsd: 0.0003, agentName: 'llm-chat', requestType: 'chat' });
    // Another provider's spend is not OpenRouter work.
    logUsage({ userId: null, model: 'claude-opus-5-5', provider: 'anthropic', inputTokens: 10, outputTokens: 1,
      costUsd: 9, agentName: 'claude-code', requestType: 'completion' });

    const work = await readWork();
    expect(work.scope).toBe('o8-work');
    expect(work.duplicateRows).toBe(0);
    expect(work.totals.calls).toBe(5);
    expect(work.totals.failedCalls).toBe(1);
    expect(work.totals.reportedUsd).toBeCloseTo(0.003, 10);
    expect(work.totals.estimatedUsd).toBeCloseTo(0.0005, 10);
    expect(work.totals.unlabeledUsd).toBeCloseTo(0.0003, 10);
    expect(work.totals.unknownCostCalls).toBe(1);
    expect(work.totals.unknownReservedUsd).toBeGreaterThan(0);
    const lead402 = work.bySource.find(group => group.key === 'Pi lead');
    expect(lead402).toMatchObject({ calls: 2, unknownCostCalls: 1 });
    expect(lead402?.reportedUsd).toBeCloseTo(0.001, 10);
    expect(work.bySource.find(group => group.key === 'Pi worker')?.reportedUsd).toBeCloseTo(0.002, 10);
  });

  it('drops a duplicate generation row written by another path instead of adding its cost', async () => {
    logUsage({ userId: null, model: `openrouter/${MODEL}`, provider: 'openrouter', inputTokens: 100, outputTokens: 10,
      costUsd: 0.002, role: 'worker', agentName: 'pi', requestType: 'chat',
      metadata: { runtime: 'pi', carrier: 'openrouter', costSource: 'provider_response', generationId: 'gen-worker-1', status: 'completed' } });
    const work = await readWork();
    expect(work.duplicateRows).toBe(1);
    expect(work.totals.reportedUsd).toBeCloseTo(0.003, 10);
    expect(work.totals.calls).toBe(5);
  });
});
