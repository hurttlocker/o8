import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { DEFAULT_O8_API_BASE_URL } from '@/lib/hosted-service';

// Report BCJBBJ: on a packaged install the free o8 model died with a raw
// "set OPENROUTER_API_KEY…" error because the operator route only read
// process.env. A signed-in founder is entitled to o8-managed inference (the
// same /v1/inference proxy the Brain uses, verified to stream). These tests
// prove the endpoint override actually routes streamOpenRouterFallback to the
// proxy URL + plan-token headers instead of OpenRouter with a raw key.

const mockFetch = vi.fn();

function sse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

function chunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('operator managed-proxy endpoint override', () => {
  it('POSTs to the proxy URL with the plan-token headers, never OpenRouter + apiKey', async () => {
    mockFetch.mockResolvedValueOnce(sse([chunk({ content: 'hi' }), 'data: [DONE]\n\n']));
    const { streamOpenRouterFallback } = await import('./operator-fallback');

    const res = await streamOpenRouterFallback({
      apiKey: 'UNUSED-should-not-appear',
      endpoint: {
        url: `${DEFAULT_O8_API_BASE_URL}/v1/inference`,
        headers: { Authorization: 'Bearer plan.token.jwt' },
      },
      messages: [{ role: 'user', content: 'hey' }],
      model: 'nvidia/nemotron-nano-9b-v2:free',
      auth: null,
    });
    await drain(res);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${DEFAULT_O8_API_BASE_URL}/v1/inference`);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer plan.token.jwt');
    // The raw OpenRouter key must NOT leak into the proxy request.
    expect(JSON.stringify(headers)).not.toContain('UNUSED-should-not-appear');
  });

  it('falls back to OpenRouter + apiKey when no endpoint override is given', async () => {
    mockFetch.mockResolvedValueOnce(sse([chunk({ content: 'hi' }), 'data: [DONE]\n\n']));
    const { streamOpenRouterFallback } = await import('./operator-fallback');

    const res = await streamOpenRouterFallback({
      apiKey: 'sk-or-directkey',
      messages: [{ role: 'user', content: 'hey' }],
      model: 'nvidia/nemotron-nano-9b-v2:free',
      auth: null,
    });
    await drain(res);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-or-directkey');
  });
});

describe('operator chain on the OpenAI-compatible route', () => {
  it('leads with the managed text model, reasoning off, then the $0 model without a reasoning field', async () => {
    const { OPERATOR_OPENROUTER_MODELS } = await import('./provider-config');
    expect(OPERATOR_OPENROUTER_MODELS).toEqual(['openai/gpt-6-luna', 'nvidia/nemotron-3.5-lightning:free']);
    const { streamOpenRouterFallback } = await import('./operator-fallback');
    for (const model of OPERATOR_OPENROUTER_MODELS) {
      mockFetch.mockResolvedValueOnce(sse([chunk({ content: 'hi' }), 'data: [DONE]\n\n']));
      await drain(await streamOpenRouterFallback({
        apiKey: '',
        endpoint: { url: `${DEFAULT_O8_API_BASE_URL}/v1/inference`, headers: { Authorization: 'Bearer plan.token.jwt' } },
        messages: [{ role: 'user', content: 'hey' }],
        model,
        auth: null,
      }));
    }
    const bodies = mockFetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies[0]).toMatchObject({ model: 'openai/gpt-6-luna', reasoning_effort: 'none' });
    expect(bodies[1].model).toBe('nvidia/nemotron-3.5-lightning:free');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
  });
});
