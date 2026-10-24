import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@earendil-works/pi-ai/compat';
import { createOpenRouterPiTransport, openRouterPiModel, OpenRouterSpendCeiling, type OpenRouterPiReceipt } from './openrouter-transport';

const pricing = { inputPerMillion: 1, outputPerMillion: 2 };
const context = { systemPrompt: 'Stable instructions. '.repeat(600),
  messages: [{ role: 'user', content: 'Do the task', timestamp: 1 }],
  tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } }],
} as unknown as Context;
function completion() {
  return new Response('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
    choices: [{ index: 0, delta: { content: 'Ready' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2000, completion_tokens: 1, cost: 0.0002,
      prompt_tokens_details: { cached_tokens: 1900, cache_write_tokens: 100 } } }) + '\n\ndata: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('OpenRouter prompt caching through the provider adapter', () => {
  it.each(['openai/gpt-6-sol', 'anthropic/claude-sonnet-4.6'])('requests supported retention and records cache metrics for %s', async modelId => {
    const calls: Record<string, unknown>[] = [];
    const receipts: OpenRouterPiReceipt[] = [];
    const transport = createOpenRouterPiTransport({ model: openRouterPiModel(modelId, pricing), pricing,
      ceiling: new OpenRouterSpendCeiling(1), resolveKey: async () => 'fixture',
      fetch: vi.fn(async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return completion(); }),
      onReceipt: receipt => receipts.push(receipt) });
    const controller = new AbortController();
    try { for await (const _event of transport(context, controller.signal)) { /* consume */ } }
    finally { controller.abort(); }
    const body = calls.at(-1)!;
    expect(JSON.stringify(body.tools)).not.toContain('cache_control');
    if (modelId.startsWith('openai/')) {
      expect(body.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '12h' });
      expect(JSON.stringify(body.messages)).toContain('prompt_cache_breakpoint');
    } else {
      expect(JSON.stringify(body.messages)).toContain('"ttl":"1h"');
    }
    expect(receipts.at(-1)).toMatchObject({ purpose: 'turn', cacheWriteTokens: 100, cachedTokenRatio: 0.95 });
    expect(receipts.at(-1)?.timeToFirstTokenMs).toEqual(expect.any(Number));
  });
});

async function consume(transport: ReturnType<typeof createOpenRouterPiTransport>, signal: AbortSignal) {
  for await (const _event of transport(context, signal)) { /* consume */ }
}

it('bounds prewarming, recovers from a failed warm request and re-resolves the host key', async () => {
  const receipts: OpenRouterPiReceipt[] = [];
  const resolveKey = vi.fn(async () => 'current-fixture-key');
  const fetchMock = vi.fn(async () => fetchMock.mock.calls.length === 1
    ? new Response('unavailable', { status: 503 }) : completion());
  const transport = createOpenRouterPiTransport({ model: openRouterPiModel('openai/gpt-6-sol', pricing), pricing,
    ceiling: new OpenRouterSpendCeiling(1), resolveKey, fetch: fetchMock,
    onReceipt: receipt => receipts.push(receipt) });
  const controller = new AbortController();
  try {
    await transport.prepare!(context, controller.signal);
    await transport.prepare!(context, controller.signal);
    await consume(transport, controller.signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveKey).toHaveBeenCalledTimes(2);
    expect(receipts.map(receipt => [receipt.purpose, receipt.status])).toEqual([['prewarm', 'failed'], ['turn', 'completed']]);
    expect(receipts[0].costUsd).toBeNull();
  } finally { controller.abort(); }
});

it('reserves the extended write rate and sends nothing when the ceiling cannot cover warming', async () => {
  const fetchMock = vi.fn(async () => completion());
  const receipts: OpenRouterPiReceipt[] = [];
  const ceiling = new OpenRouterSpendCeiling(0.000001);
  const transport = createOpenRouterPiTransport({ model: openRouterPiModel('anthropic/claude-sonnet-4.6', pricing), pricing,
    ceiling, resolveKey: async () => 'fixture', fetch: fetchMock, onReceipt: receipt => receipts.push(receipt) });
  const controller = new AbortController();
  await transport.prepare!(context, controller.signal);
  controller.abort();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(receipts).toMatchObject([{ purpose: 'prewarm', status: 'refused', reservedUsd: 0 }]);
  expect(ceiling.spentUsd).toBe(0);
});

it('cancels an in-flight warm request and retains its unknown-cost reservation', async () => {
  const ceiling = new OpenRouterSpendCeiling(1);
  const receipts: OpenRouterPiReceipt[] = [];
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const transport = createOpenRouterPiTransport({ model: openRouterPiModel('openai/gpt-6-sol', pricing), pricing,
    ceiling, resolveKey: async () => 'fixture', onReceipt: receipt => receipts.push(receipt),
    fetch: async (_url, init) => {
      entered();
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
    } });
  const controller = new AbortController();
  const pending = transport.prepare!(context, controller.signal);
  await started;
  controller.abort();
  await pending;
  expect(receipts).toMatchObject([{ purpose: 'prewarm', status: 'stopped', costUsd: null }]);
  expect(ceiling.spentUsd).toBeGreaterThan(0);
});

it('keeps unsupported models on the existing transport lifecycle', () => {
  const transport = createOpenRouterPiTransport({ model: openRouterPiModel('fixture/model', pricing), pricing,
    ceiling: new OpenRouterSpendCeiling(1), resolveKey: async () => null });
  expect(transport.prepare).toBeUndefined();
  expect(transport.duringTool).toBeUndefined();
});

it('does not send or reserve a delayed credential lookup after the run stops', async () => {
  let release!: (key: string) => void;
  let entered!: () => void;
  const lookup = new Promise<string>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fetchMock = vi.fn(async () => completion());
  const ceiling = new OpenRouterSpendCeiling(1);
  const transport = createOpenRouterPiTransport({ model: openRouterPiModel('openai/gpt-6-sol', pricing), pricing, ceiling,
    resolveKey: async () => { entered(); return lookup; }, fetch: fetchMock });
  const controller = new AbortController();
  const pending = transport.prepare!(context, controller.signal);
  await started;
  controller.abort(); release('fixture');
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(ceiling.spentUsd).toBe(0);
});
