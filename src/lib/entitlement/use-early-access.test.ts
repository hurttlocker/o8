// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let container: HTMLDivElement;
let root: Root;
let plan: unknown;

beforeEach(() => {
  vi.resetModules();
  plan = 'free';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/panel/entitlement') return Response.json({ plan });
    if (url === '/api/panel/operator-defaults?include=values') {
      return Response.json({ values: {} });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountProbe() {
  const { useEarlyAccess } = await import('./use-early-access');
  const { useExperimentalGeminiFlag } = await import('@/lib/operator/use-experimental-gemini');
  const { useExperimentalOpencodeFlag } = await import('@/lib/operator/use-experimental-opencode');
  const { useExperimentalCanvasFlag } = await import('@/lib/operator/use-experimental-canvas');
  const { useExperimentalChatFlag } = await import('@/lib/operator/use-experimental-chat');
  function Probe() {
    return createElement('output', {
      'data-early-access': String(useEarlyAccess()),
      'data-gemini': String(useExperimentalGeminiFlag()),
      'data-opencode': String(useExperimentalOpencodeFlag()),
      'data-canvas': String(useExperimentalCanvasFlag()),
      'data-chat': String(useExperimentalChatFlag()),
    });
  }
  await act(async () => root.render(createElement(Probe)));
}

describe('paid-plan early access through the remote hooks', () => {
  it.each([
    ['free', false],
    ['pro', true],
    ['founder', true],
    ['team', true],
    ['unknown', false],
  ])('resolves %s with operator flags off', async (nextPlan, enabled) => {
    plan = nextPlan;
    await mountProbe();
    expect(container.querySelector('output')?.dataset).toMatchObject({
      earlyAccess: String(enabled),
      gemini: String(enabled),
      opencode: String(enabled),
      canvas: 'true',
      chat: 'false',
    });
    expect(fetch).toHaveBeenCalledWith('/api/panel/entitlement', {
      signal: expect.any(AbortSignal),
    });
  });

  it('updates mounted consumers when the entitlement refreshes', async () => {
    await mountProbe();
    for (const [nextPlan, enabled] of [['pro', true], ['free', false], ['founder', true]] as const) {
      plan = nextPlan;
      await act(async () => window.dispatchEvent(new Event('o8:entitlement-refresh')));
      expect(container.querySelector('output')?.dataset).toMatchObject({
        earlyAccess: String(enabled),
        gemini: String(enabled),
        opencode: String(enabled),
      });
    }
  });

  it('retries an unavailable entitlement instead of caching denied access', async () => {
    vi.useFakeTimers();
    plan = 'pro';
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    const { useEarlyAccess } = await import('./use-early-access');
    function Probe() {
      return createElement('output', null, String(useEarlyAccess()));
    }
    await act(async () => root.render(createElement(Probe)));
    expect(container.textContent).toBe('false');
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(container.textContent).toBe('true');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
