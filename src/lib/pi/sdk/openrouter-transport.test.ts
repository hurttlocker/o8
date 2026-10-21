import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessageEvent, Context } from '@earendil-works/pi-ai/compat';
import {
  createOpenRouterPiTransport,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  OpenRouterSpendCeiling,
  openRouterPiModel,
  worstCaseCallUsd,
  type OpenRouterPiReceipt,
} from './openrouter-transport';

const pricing = { inputPerMillion: 0.3, outputPerMillion: 1.2 };
const model = openRouterPiModel('deepseek/deepseek-v4.1-flash', pricing, 64_000);
const context = { messages: [{ role: 'user', content: 'Say hello.', timestamp: 1 }] } as unknown as Context;

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const completion = (usage: Record<string, unknown> | null) => sse([
  { id: 'gen-fixture-1', object: 'chat.completion.chunk', created: 1, model: 'deepseek/deepseek-v4.1-flash',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello.' }, finish_reason: null }] },
  { id: 'gen-fixture-1', object: 'chat.completion.chunk', created: 1, model: 'deepseek/deepseek-v4.1-flash',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(usage ? { usage } : {}) },
]);

async function run(options: { fetch: typeof fetch; key?: string | null; ceiling?: OpenRouterSpendCeiling }) {
  const receipts: OpenRouterPiReceipt[] = [];
  const ceiling = options.ceiling ?? new OpenRouterSpendCeiling(1);
  const transport = createOpenRouterPiTransport({
    model, pricing, ceiling, fetch: options.fetch,
    resolveKey: async () => options.key === undefined ? 'fixture-openrouter-key' : options.key,
    onReceipt: receipt => receipts.push(receipt),
  });
  const events: AssistantMessageEvent[] = [];
  for await (const event of transport(context, new AbortController().signal)) events.push(event);
  return { events, receipts, ceiling };
}

describe('Pi OpenRouter transport', () => {
  it('sends Pi\'s request body to OpenRouter with a host-held key and records the reported cost once', async () => {
    const fetchMock = vi.fn(async () => completion({ prompt_tokens: 120, completion_tokens: 8, total_tokens: 128, cost: 0.0000456,
      prompt_tokens_details: { cached_tokens: 20 } }));
    const { events, receipts, ceiling } = await run({ fetch: fetchMock as unknown as typeof fetch });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fixture-openrouter-key');
    const body = JSON.parse(String(init.body)) as { model: string; messages: unknown[] };
    expect(body.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(String(init.body)).not.toContain('fixture-openrouter-key');
    expect(events.some(event => event.type === 'done')).toBe(true);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ generationId: 'gen-fixture-1', model: 'deepseek/deepseek-v4.1-flash', status: 'completed',
      inputTokens: 120, outputTokens: 8, cacheReadTokens: 20, costUsd: 0.0000456 });
    expect(ceiling.spentUsd).toBeCloseTo(0.0000456, 10);
  });

  it('refuses a call before it is sent when its worst case would pass the run ceiling', async () => {
    const fetchMock = vi.fn(async () => completion({ prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 }));
    const tiny = new OpenRouterSpendCeiling(worstCaseCallUsd(10, 4096, pricing));
    const { events, receipts } = await run({ fetch: fetchMock as unknown as typeof fetch, ceiling: tiny });
    expect(fetchMock).not.toHaveBeenCalled();
    const failure = events.find(event => event.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(failure.error.errorMessage).toBe('OpenRouter spend ceiling reached for this run');
    expect(receipts[0]).toMatchObject({ status: 'refused', costUsd: null, reservedUsd: 0 });
    expect(tiny.spentUsd).toBe(0);
  });

  it('refuses without a connected key and never falls back', async () => {
    const fetchMock = vi.fn();
    const { events } = await run({ fetch: fetchMock as unknown as typeof fetch, key: null });
    expect(fetchMock).not.toHaveBeenCalled();
    const failure = events.find(event => event.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(failure.error.errorMessage).toBe('OpenRouter is not connected');
  });

  it('keeps a rejected call\'s reservation counted and never exposes the provider\'s error body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'raw provider detail' } }), { status: 429 }));
    const { events, receipts, ceiling } = await run({ fetch: fetchMock as unknown as typeof fetch });
    const failure = events.find(event => event.type === 'error') as Extract<AssistantMessageEvent, { type: 'error' }>;
    expect(failure.error.errorMessage).toBe('OpenRouter rejected the request (429)');
    expect(JSON.stringify(events)).not.toContain('raw provider detail');
    expect(receipts[0]).toMatchObject({ status: 'failed', costUsd: null });
    expect(ceiling.spentUsd).toBeGreaterThan(0);
  });

  it('records a call without a reported cost as unknown, not as free', async () => {
    const { receipts, ceiling } = await run({ fetch: vi.fn(async () => completion({ prompt_tokens: 50, completion_tokens: 5 })) as unknown as typeof fetch });
    expect(receipts[0]).toMatchObject({ status: 'completed', costUsd: null });
    expect(ceiling.spentUsd).toBe(receipts[0].reservedUsd);
  });
});
