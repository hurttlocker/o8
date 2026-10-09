// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { UsageWorkspace } from './UsageWorkspace';

const row = { day: '2026-10-08', provider: 'claude', model: 'external-model', totals: { uncachedInputTokens: 10, cachedInputTokens: 90, cacheCreationTokens: 0, outputTokens: 20, reasoningTokens: 0 },
  costUsd: 0, cacheSavingsUsd: 0, categoryCostUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, sessions: 1, records: 1, unpricedRecords: 1, reportedRecords: 0, fastCostUsd: 0, speedPremiumUsd: 0 };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('shows global history through the workspace, ranges, providers, keyboard chart and unpriced rows, retaining data after refresh failure', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); let fail = false;
  const fetchMock = vi.fn(async (url: string) => url.startsWith('/api/runtime/capacity') ? Response.json({ schema: 'o8/runtime-capacity-control/v1', capacities: [], identities: [] })
    : fail ? Response.json({}, { status: 503 }) : Response.json({ schema: 'o8/usage-history/v1', observedAt: '2026-10-08T21:00:00Z',
      since: Date.parse('2026-10-07T21:00:00Z'), until: Date.parse('2026-10-08T21:00:00Z'), timeZone: 'UTC', buckets: [row], providerSessions: { claude: 1 },
      sources: [{ provider: 'claude', status: 'ready', files: 1, records: 1 }], pricing: { status: 'bundled', observedAt: '2026-10-08' } }));
  vi.stubGlobal('fetch', fetchMock);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  try {
    await act(async () => root.render(createElement(UsageWorkspace))); await settle();
    await act(async () => host.querySelector<HTMLButtonElement>('#usage-tokens-tab')!.click()); await settle();
    expect(host.textContent).toContain('external-model'); expect(host.textContent).toContain('Unpriced');
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Past 24h')!.click()); await settle();
    expect(fetchMock.mock.calls.some(([url]) => url.includes('days=1'))).toBe(true);
    const chart = host.querySelector('svg[role="img"]')!;
    await act(async () => chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain('Total');
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Hour')?.click());
    const provider = host.querySelector<HTMLSelectElement>('[aria-label="CLI provider"]')!;
    await act(async () => { provider.value = 'codex'; provider.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.textContent).toContain('No recorded CLI usage');
    await act(async () => { provider.value = 'all'; provider.dispatchEvent(new Event('change', { bubbles: true })); });
    fail = true; const refresh = host.querySelector<HTMLButtonElement>('[aria-label="Refresh usage"]')!;
    await act(async () => refresh.focus()); expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Refresh usage');
    await act(async () => refresh.click()); await settle();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('fresh=1');
    expect(host.textContent).toContain('Previous observations remain visible'); expect(host.textContent).toContain('Unpriced');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
