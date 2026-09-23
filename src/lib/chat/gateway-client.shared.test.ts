import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ generateText: vi.fn(), createGateway: vi.fn(), callOpenRouter: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('ai', () => ({ generateText: h.generateText, streamText: vi.fn() }));
vi.mock('@ai-sdk/gateway', () => ({
  createGateway: h.createGateway.mockImplementation(() => (modelId: string) => ({ modelId })),
}));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => '/tmp/o8-shared-test' }));
vi.mock('@/lib/cortex/qa/llm/openrouter-adapter', () => ({ callOpenRouter: h.callOpenRouter }));

import { generateSharedSymonText } from './gateway-client';

const previousKey = process.env.VERCEL_AI_GATEWAY_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VERCEL_AI_GATEWAY_API_KEY = 'local-test-key';
  h.generateText.mockResolvedValue({ text: 'The plan is tentative.' });
  h.callOpenRouter.mockResolvedValue('The plan is tentative.');
});

it('falls back to existing tool-free inference routing without a gateway key', async () => {
  delete process.env.VERCEL_AI_GATEWAY_API_KEY;
  expect(await generateSharedSymonText('Reference: a working plan.')).toBe('The plan is tentative.');
  expect(h.generateText).not.toHaveBeenCalled();
  expect(h.callOpenRouter).toHaveBeenCalledWith(
    expect.stringContaining('Reference: a working plan.'),
    expect.objectContaining({ maxTokens: 2048 }),
  );
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.VERCEL_AI_GATEWAY_API_KEY;
  else process.env.VERCEL_AI_GATEWAY_API_KEY = previousKey;
});

it('sends only supplied text to a provider with no tools or private context', async () => {
  const reply = await generateSharedSymonText('Reference: a working plan.');
  expect(reply).toBe('The plan is tentative.');
  const options = h.generateText.mock.calls[0][0] as Record<string, unknown>;
  expect(options).not.toHaveProperty('tools');
  expect(options).not.toHaveProperty('toolChoice');
  expect(options).not.toHaveProperty('providerOptions');
  expect(options.messages).toEqual([
    expect.objectContaining({ role: 'system', content: expect.stringContaining('no tools') }),
    { role: 'user', content: 'Reference: a working plan.' },
  ]);
});
