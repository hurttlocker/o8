// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { UsageWorkspace } from './UsageWorkspace';
import { UsageHistoryPanel } from './UsageHistoryPanel';
import { usageChartPoints, usageChartTicks } from './usage-chart-data';
import type { UsageHistorySummary } from '@/lib/usage/history-types';

const row = { day: '2026-10-08', provider: 'claude' as const, model: 'external-model', totals: { uncachedInputTokens: 10, cachedInputTokens: 90, cacheCreationTokens: 0, outputTokens: 20, reasoningTokens: 0 },
  costUsd: 0, cacheSavingsUsd: 0, categoryCostUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, sessions: 1, records: 1, unpricedRecords: 1, reportedRecords: 0, fastCostUsd: 0, speedPremiumUsd: 0 };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('shows global history through the workspace, ranges, providers, keyboard chart and unpriced rows, retaining data after refresh failure', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); let fail = false;
  const fetchMock = vi.fn(async (url: string) => url.includes('machines=1') ? Response.json({ schema: 'o8/usage-machines/v1', machines: [{ id: 'local', label: 'This machine', local: true, enabled: true }] })
    : url.startsWith('/api/runtime/capacity') ? Response.json({ schema: 'o8/runtime-capacity-control/v1', capacities: [], identities: [] })
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

it('shows speed costs without adding the premium twice, filters zero series, and keeps unpriced chart values explicit', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const snapshot: UsageHistorySummary = { schema: 'o8/usage-history/v1', observedAt: '2026-10-08T21:00:00Z',
    since: Date.parse('2026-09-09T04:00:00Z'), until: Date.parse('2026-10-08T21:00:00Z'), timeZone: 'America/New_York',
    buckets: [{ ...row, costUsd: 100, fastCostUsd: 50, speedPremiumUsd: 25, unpricedRecords: 0 },
      { ...row, provider: 'codex', costUsd: 120, unpricedRecords: 0 },
      { ...row, provider: 'antigravity', totals: { ...row.totals, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, unpricedRecords: 0 }],
    providerSessions: { claude: 1, codex: 1, antigravity: 1 }, sources: [], pricing: { status: 'bundled', source: 'fixture', observedAt: '2026-10-08' },
    scan: { filesRead: 0, bytesRead: 0, durationMs: 0 } };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(UsageHistoryPanel, { snapshot, mode: 'cost', provider: 'all' })));
    const speed = host.querySelector('[aria-label="Cost by speed"]')!;
    expect(speed.textContent).toContain('$170.00'); expect(speed.textContent).toContain('$50.00');
    expect(speed.textContent).toContain('$25.00'); expect(speed.textContent).toContain('already included above');
    expect(host.querySelector('[data-usage-provider-mark="claude"]')).not.toBeNull();
    expect(host.querySelector('[data-usage-series="antigravity"]')).toBeNull();
    expect([...host.querySelectorAll('[data-usage-series] path')].every(path => !path.getAttribute('d')?.includes('NaN'))).toBe(true);
    const chart = host.querySelector('svg[role="img"]')!;
    await act(async () => chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(host.querySelector('[data-usage-chart-tooltip]')?.textContent).toContain('$220.00');
    await act(async () => root.render(createElement(UsageHistoryPanel, { snapshot: { ...snapshot, buckets: [row] }, mode: 'cost', provider: 'all' })));
    const tip = host.querySelector('[data-usage-chart-tooltip]');
    expect(tip?.textContent).toContain('Unpriced'); expect(tip?.textContent).not.toContain('$0.00');
    await act(async () => chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[data-usage-chart-tooltip]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('follows pointer movement within one day and hides the first machine’s data while another loads', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('machines=1')) return Response.json({ schema: 'o8/usage-machines/v1', machines: [
      { id: 'local', label: 'This machine', local: true, enabled: true }, { id: 'remote', label: 'Build host', local: false, enabled: true }] });
    if (url.includes('/capacity')) return Response.json({ schema: 'o8/runtime-capacity-control/v1', capacities: [], identities: [] });
    const remote = url.includes('machine=remote'); if (remote) await pending;
    return Response.json({ schema: 'o8/usage-history/v1', machine: { id: remote ? 'remote' : 'local' }, observedAt: '2026-10-08T21:00:00Z',
      since: Date.parse('2026-10-08T00:00:00Z'), until: Date.parse('2026-10-08T21:00:00Z'), timeZone: 'UTC',
      buckets: [{ ...row, model: remote ? 'remote-model' : 'local-model' }], providerSessions: { claude: 1 }, sources: [], pricing: { status: 'bundled' } });
  }));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  try {
    await act(async () => root.render(createElement(UsageWorkspace))); await settle();
    await act(async () => host.querySelector<HTMLButtonElement>('#usage-cost-tab')!.click()); await settle();
    const chart = host.querySelector<SVGSVGElement>('svg[role="img"]')!;
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 680, height: 270 } as DOMRect);
    vi.spyOn(chart.parentElement!, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 680, height: 300 } as DOMRect);
    await act(async () => chart.dispatchEvent(new MouseEvent('pointermove', { clientX: 200, clientY: 80, bubbles: true })));
    const tooltip = host.querySelector<HTMLDivElement>('[data-usage-chart-tooltip]')!;
    const first = tooltip.style.transform;
    await act(async () => chart.dispatchEvent(new MouseEvent('pointermove', { clientX: 240, clientY: 110, bubbles: true })));
    expect(tooltip.style.transform).not.toBe(first); expect(tooltip.textContent).toContain('Oct 8');
    const machine = host.querySelector<HTMLSelectElement>('[aria-label="Usage machine"]')!;
    await act(async () => { machine.value = 'remote'; machine.dispatchEvent(new Event('change', { bubbles: true })); }); await settle();
    expect(host.textContent).not.toContain('local-model'); expect(host.textContent).toContain('Reading Build host CLI history');
    await act(async () => release?.()); await settle();
    expect(host.textContent).toContain('remote-model'); expect(host.textContent).not.toContain('local-model');
    await act(async () => { machine.value = 'local'; machine.dispatchEvent(new Event('change', { bubbles: true })); }); await settle();
    expect(host.textContent).toContain('local-model'); expect(host.textContent).not.toContain('remote-model');
    expect(host.textContent).toContain('o8 outcomes');
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('keeps empty calendar days through the autumn clock change and uses round chart ticks', () => {
  const points = usageChartPoints([], 'tokens', Date.parse('2026-10-31T04:00:00Z'), Date.parse('2026-11-03T18:00:00Z'), false, 'America/New_York');
  expect(points.map(point => point.day)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  expect(usageChartTicks(1_030_000_000)).toEqual([0, 500_000_000, 1_000_000_000, 1_500_000_000]);
});
