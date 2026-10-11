import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveOpenRouterRoute: vi.fn(),
}));

vi.mock('@/lib/cortex/qa/llm/inference-route', () => ({
  resolveOpenRouterRoute: mocks.resolveOpenRouterRoute,
}));

const resolveOpenRouterRoute = mocks.resolveOpenRouterRoute;

const { POST } = await import('./route');

function request(body: unknown) {
  return new NextRequest('http://127.0.0.1/api/mobile/ripple/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  resolveOpenRouterRoute.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/mobile/ripple/resolve', () => {
  it('rejects an empty utterance', async () => {
    const response = await POST(request({ utterance: '' }));
    expect(response.status).toBe(400);
  });

  it('does not gate voice when inference is unavailable', async () => {
    resolveOpenRouterRoute.mockResolvedValue(null);

    const response = await POST(request({ utterance: 'make this faster but keep the old interaction' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'none' });
  });

  it('returns one bounded AODL resolution from the real route entry point', async () => {
    resolveOpenRouterRoute.mockResolvedValue({
      url: 'https://example.test/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      via: 'direct',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            kind: 'choice',
            question: 'What should be faster?',
            options: [
              { label: 'Input latency', value: 'input-latency' },
              { label: 'Animation', value: 'animation-duration' },
              { label: 'Both', value: 'both' },
            ],
            aodlPath: 'constraints.latency',
            confidence: 0.86,
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const response = await POST(request({
      utterance: 'make this faster but keep the old interaction',
      repoName: 'o8',
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.kind).toBe('choice');
    expect(body.aodlPath).toBe('constraints.latency');
    expect(body.options).toHaveLength(3);
    expect(typeof body.id).toBe('string');
  });
});
