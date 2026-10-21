import { afterEach, expect, it, vi } from 'vitest';
import { generateFollowUps, streamAssistantResponse } from './streaming';

vi.mock('@/lib/chatgpt-plan/client', () => ({ planAccountHeaders: async () => ({ 'x-clerk-session-token': 'fixture-o8-session' }) }));

const options = () => ({ approvedToolsSet: new Set<string>(), controller: new AbortController(), messageForModel: 'A bounded question', messages: [], model: { id: 'chatgpt:fixture-plan-model', label: 'Fixture model', provider: 'chatgpt' as const, backend: 'api' as const, color: 'var(--t-text)', description: 'ChatGPT plan' }, showTypingIndicator: false, tabId: 'fixture-chat', onPendingApproval: vi.fn(), onStreamContent: vi.fn(), onThinking: vi.fn(), onToolCalls: vi.fn(), onTypingIndicatorChange: vi.fn() });
afterEach(() => vi.unstubAllGlobals());

it('reads split SSE frames and retains subscription-route metadata without estimated API cost', async () => {
  const text = `data: ${JSON.stringify({ type: 'content', text: 'A plan answer' })}\n\ndata: ${JSON.stringify({ type: 'usage', inputTokens: 12, outputTokens: 3, costUsd: null })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (let index = 0; index < bytes.length; index += 5) controller.enqueue(bytes.subarray(index, index + 5)); controller.close(); } })));
  vi.stubGlobal('fetch', fetch);
  const result = await streamAssistantResponse(options());
  expect(result.assistantMessage).toMatchObject({ content: 'A plan answer', tokens: { input: 12, output: 3 }, inferenceRoute: { provider: 'chatgpt-plan', billing: 'subscription', allowanceUse: 'unknown', meter: 'provider-tokens' } });
  expect(result.assistantMessage.costUsd).toBeUndefined();
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ provider: 'chatgpt', model: 'fixture-plan-model' });
});

it('holds a cut-off desktop stream and makes no automatic retry or additional payer call', async () => {
  const fetch = vi.fn(async () => new Response('data: {"type":"content","text":"Partial"}\n\n'));
  vi.stubGlobal('fetch', fetch);
  await expect(streamAssistantResponse(options())).rejects.toThrow(/before completion/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not generate automatic extra inference for follow-up suggestions', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await generateFollowUps('Answer', options().model, 'Question')).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it('holds malformed stream data even if a completion marker follows it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {bad\n\ndata: [DONE]\n\n')));
  await expect(streamAssistantResponse(options())).rejects.toThrow(/could not be read/);
});
