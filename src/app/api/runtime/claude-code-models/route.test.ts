import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), metadata: vi.fn() }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: mocks.auth }));
vi.mock('@/lib/orchestrator/openrouter-model-metadata', () => ({ getOpenRouterModelMetadata: mocks.metadata }));
beforeEach(() => { vi.resetModules(); mocks.auth.mockReturnValue(null); mocks.metadata.mockResolvedValue(new Map()); vi.unstubAllGlobals(); });

it('uses public metadata only for models with both harness tool capabilities', async () => {
  mocks.metadata.mockResolvedValue(new Map([['openrouter/test/model', { rank: 0, compatible: true, contextLength: 200_000, inputPricePerMillion: 1, outputPricePerMillion: 2 }]]));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [
    { id: 'test/model', name: 'Tools model', supported_parameters: ['tools', 'tool_choice'] },
    { id: 'test/no-choice', supported_parameters: ['tools'] },
  ] }))));
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://localhost/api/runtime/claude-code-models?sort=newest'));
  const payload = await response.json();
  expect(response.status).toBe(200);
  expect(mocks.metadata).toHaveBeenCalledWith('newest');
  expect(payload.total).toBe(1);
  expect(payload.groups[0].provider).toBe('openrouter');
  expect(payload.groups[0].models[0]).toMatchObject({ id: 'test/model', metadata: { contextLength: 200_000 } });
  const cached = await GET(new NextRequest('http://localhost/api/runtime/claude-code-models?sort=newest'));
  expect((await cached.json()).source).toBe('cache');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not fetch a catalogue for an unauthenticated panel request', async () => {
  mocks.auth.mockReturnValue(new Response(null, { status: 401 }));
  vi.stubGlobal('fetch', vi.fn());
  const { GET } = await import('./route');
  expect((await GET(new NextRequest('http://localhost/api/runtime/claude-code-models'))).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});
