// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let container: HTMLDivElement;
let root: Root;
let enabled: boolean;

beforeEach(() => {
  vi.resetModules();
  enabled = false;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/panel/operator-defaults?include=values') {
      return Response.json({ values: { experimentalGemini: enabled, experimentalOpencode: enabled } });
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
  const { useExperimentalGeminiFlag } = await import('@/lib/operator/use-experimental-gemini');
  const { useExperimentalOpencodeFlag } = await import('@/lib/operator/use-experimental-opencode');
  const { useExperimentalCanvasFlag } = await import('@/lib/operator/use-experimental-canvas');
  const { useExperimentalChatFlag } = await import('@/lib/operator/use-experimental-chat');
  function Probe() {
    return createElement('output', {
      'data-gemini': String(useExperimentalGeminiFlag()),
      'data-opencode': String(useExperimentalOpencodeFlag()),
      'data-canvas': String(useExperimentalCanvasFlag()),
      'data-chat': String(useExperimentalChatFlag()),
    });
  }
  await act(async () => root.render(createElement(Probe)));
}

describe('free edition stability controls through mounted hooks', () => {
  it.each([false, true])('uses explicit operator toggles: %s', async (value) => {
    enabled = value;
    await mountProbe();
    expect(container.querySelector('output')?.dataset).toMatchObject({
      gemini: String(value), opencode: String(value), canvas: 'true', chat: 'false',
    });
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).includes('operator-defaults'))).toBe(true);
  });

  it('does not grant experimental access when operator defaults are unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    await mountProbe();
    expect(container.querySelector('output')?.dataset).toMatchObject({
      gemini: 'false', opencode: 'false', canvas: 'true', chat: 'false',
    });
  });
});
