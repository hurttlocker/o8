// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./OpenRouterModelsSection', () => ({ OpenRouterModelsSection: () => createElement('p', null, 'OpenRouter model visibility') }));

import { OpenRouterProviderPanel } from './OpenRouterConnectionCard';

const connected = {
  state: 'connected', enabled: true, checkedAt: '2026-10-14T08:00:00.000Z', lastError: null,
  details: { limit: 10, limitRemaining: 8.5, usageDaily: 0.25, usageMonthly: 3, isFreeTier: false, expiresAt: null },
};
const disabled = { ...connected, state: 'disabled', enabled: false };

afterEach(() => { vi.unstubAllGlobals(); });

it('shows key figures as key-wide, turns the connection off and hides models while off', async () => {
  let current: typeof connected = connected;
  const request = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'PATCH') current = disabled;
    return {
      ok: true,
      status: 200,
      json: async () => options?.method === 'PATCH'
        ? { success: true, connection: current }
        : { providers: [{ id: 'openrouter', connection: current }] },
    };
  });
  vi.stubGlobal('fetch', request);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(OpenRouterProviderPanel)); });
    expect(container.textContent).toContain('connected');
    expect(container.textContent).toContain('Today $0.2500');
    expect(container.textContent).toContain('including use outside o8');
    expect(container.textContent).toContain('OpenRouter model visibility');
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Turn off')!.click(); });
    const patch = request.mock.calls.find(([, options]) => options?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ provider: 'openrouter', enabled: false });
    expect(container.textContent).toContain('make no OpenRouter calls while this is off');
    expect(container.textContent).not.toContain('OpenRouter model visibility');
    expect(container.textContent).not.toContain('Check now');
    expect([...container.querySelectorAll('button')].map(button => button.textContent)).toContain('Turn on');
  } finally {
    act(() => root.unmount());
  }
});

it('keeps the models picker out of a disconnected OpenRouter panel', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ providers: [{ id: 'openrouter', connection: { ...connected, state: 'disconnected', details: null } }] }) })));
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(OpenRouterProviderPanel)); });
    expect(container.textContent).toContain('not connected');
    expect(container.textContent).not.toContain('OpenRouter model visibility');
  } finally {
    act(() => root.unmount());
  }
});
