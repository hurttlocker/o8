// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Canvas } from '../Canvas';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('opens real workspace usage, renders both accounts, switches to recorded activity, and refreshes without mutations', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let fail = false;
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    if (String(url).startsWith('/api/runtime/capacity')) return fail ? Response.json({}, { status: 503 }) : Response.json({
      schema: 'o8/runtime-capacity-control/v1', generatedAt: Date.now(), identities: [], runtimes: [],
      capacities: ['codex', 'claude-code'].map((runtime, index) => ({ runtime, identityId: null, status: 'available',
        source: 'structured-cli', confidence: 'exact', observedAt: '2026-10-08T20:00:00Z', reason: null,
        buckets: [{ id: 'session', label: '5-hour', usedRatio: index ? 0.15 : 0.4, resetsAt: '2026-10-09T01:50:00Z' }] })),
    });
    if (String(url).startsWith('/api/panel/analytics')) return Response.json({
      totals: { messages: 0 }, byAgent: {}, bySurface: {}, byModel: [], hourly: [], topSessions: [], autonomy: null, governance: null,
    });
    throw new Error('Unexpected usage request');
  });
  vi.stubGlobal('fetch', fetchMock);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const props = { tabs: [{ id: 'usage', kind: 'usage' as const, label: 'Usage', resourceId: 'usage' }], activeTabId: 'usage',
    onSelectTab: vi.fn(), onCloseTab: vi.fn(), embedded: true, active: true };
  const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
  try {
    await act(async () => root.render(createElement(Canvas, props)));
    await vi.waitFor(async () => {
      await settle();
      expect(host.querySelector('[aria-label="Claude usage"]')?.textContent).toContain('15% used');
    }, { timeout: 10_000, interval: 100 });
    expect(host.querySelector('[data-mcp-scope="usage-workspace"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Claude usage"]')?.textContent).toContain('15% used');
    expect(host.querySelector('[aria-label="Codex usage"]')?.textContent).toContain('40% used');
    expect(host.textContent).toContain('Resets');
    const limits = host.querySelector<HTMLButtonElement>('#usage-limits-tab')!;
    await act(async () => limits.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    await settle();
    expect(host.querySelector('#usage-activity-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement?.id).toBe('usage-activity-tab');
    await vi.waitFor(async () => {
      await settle();
      expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/panel/analytics'))).toBe(true);
    }, { timeout: 10_000, interval: 100 });
    await act(async () => limits.click()); await settle();
    fail = true;
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh usage"]')!.click());
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/runtime/capacity?fresh=1');
    expect(host.textContent).toContain('Previous observations remain visible');
    expect(host.querySelector('[aria-label="Claude usage"]')?.textContent).toContain('15% used');
    await act(async () => root.render(createElement(Canvas, { ...props, active: false })));
  } finally { await act(async () => root.unmount()); host.remove(); }
});
