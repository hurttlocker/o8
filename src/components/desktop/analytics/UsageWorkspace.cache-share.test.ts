import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HistoryBucket, UsageHistorySummary } from '@/lib/usage/history-types';
import { UsageWorkspace } from './UsageWorkspace';

vi.mock('../AnalyticsPage', () => ({ default: () => createElement('div', null, 'Outcomes fixture') }));

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('@/lib/usage/history-roots', () => ({ resolveHistoryRoots: async () => [
  { provider: 'claude', path: join(fixture.root, 'claude'), format: 'jsonl' },
  { provider: 'codex', path: join(fixture.root, 'codex'), format: 'jsonl' },
] }));
vi.mock('@/lib/usage/history-pricing', async () => {
  const { createOverrideRateTable } = await import('@/lib/usage/history-readers/usagePricing');
  return { readHistoryPricing: async () => ({ table: createOverrideRateTable({}), at: 0,
    meta: { source: 'Fixture', observedAt: null, status: 'bundled' } }) };
});

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new () => { window: Window & typeof globalThis } };
let dom: { window: Window & typeof globalThis };
const NOW = Date.parse('2026-10-23T06:00:00Z');
let host: HTMLDivElement;
let root: Root;
let temporary: string | null = null;
beforeEach(() => {
  dom = new JSDOM();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent'] as const) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...resolved.call(this), timeZone: 'America/New_York' };
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); dom.window.close();
  if (temporary) await rm(temporary, { recursive: true, force: true }); temporary = null;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
function bucket(provider: 'claude' | 'codex', cached = 90, uncached = 10, writes = 0): HistoryBucket {
  return { day: '2026-10-23', provider, model: 'fixture', totals: { cachedInputTokens: cached,
    uncachedInputTokens: uncached, cacheCreationTokens: writes, outputTokens: 999, reasoningTokens: 99 },
  records: 1, sessions: 1, costUsd: 0, cacheSavingsUsd: 0, categoryCostUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  unpricedRecords: 1, reportedRecords: 0, fastCostUsd: 0, speedPremiumUsd: 0 };
}
function snapshot(buckets = [bucket('claude'), bucket('codex', 0, 100)]): UsageHistorySummary {
  return { schema: 'o8/usage-history/v1', observedAt: new Date(NOW).toISOString(), until: NOW,
    since: NOW - 7 * 86_400_000, timeZone: 'America/New_York', buckets, providerSessions: {},
    sources: ['claude', 'codex'].map(provider => ({ provider: provider as 'claude' | 'codex', status: 'ready', files: 1, records: 1 })),
    pricing: { source: 'Fixture', observedAt: null, status: 'bundled' }, scan: { filesRead: 2, bytesRead: 1, durationMs: 0 } };
}
function serve(history: (url: string) => Promise<Response>) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    if (String(url).startsWith('/api/runtime/capacity')) return Response.json({ schema: 'o8/runtime-capacity-control/v1', capacities: [], identities: [], runtimes: [] });
    expect(String(url)).toMatch(/^\/api\/runtime\/usage\?days=7&timeZone=America%2FNew_York&machine=local/);
    return history(String(url));
  });
  vi.stubGlobal('fetch', fetchMock); return fetchMock;
}
function fakeIntervals() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => globalThis.setInterval(callback, delay));
  vi.spyOn(window, 'clearInterval').mockImplementation(id => globalThis.clearInterval(id));
}
const row = (provider: string) => host.querySelector(`[aria-label="${provider} cache share today"]`);
const mount = async (active = true) => act(async () => root.render(createElement(UsageWorkspace, { active })));
const refresh = async () => act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh usage"]')!.click());

it('reads persisted Claude/Codex logs through the history route and mounted Usage workspace, weighting input and the local calendar day', async () => {
  temporary = await mkdtemp(join(tmpdir(), 'o8-cache-share-')); fixture.root = temporary;
  vi.stubEnv('O8_DATA_DIR', temporary);
  await mkdir(join(temporary, 'claude')); await mkdir(join(temporary, 'codex'));
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  const claude = (id: string, time: string, cached: number, uncached: number, writes = 0) => ({
    type: 'assistant', timestamp: time, sessionId: 'fixture-session', requestId: id,
    message: { id, model: id, content: 'PRIVATE-FIXTURE-CONTENT', usage: { input_tokens: uncached,
      cache_read_input_tokens: cached, cache_creation_input_tokens: writes, output_tokens: 9000 } },
  });
  const first = claude('first', '2026-10-23T04:30:00Z', 90, 10, 100);
  const claudeText = line(claude('yesterday', '2026-10-23T03:59:00Z', 9000, 1)) + line(first) + line(first)
    + line(claude('second', '2026-10-23T05:00:00Z', 10, 90));
  const codexText = line({ type: 'session_meta', payload: { id: 'fixture-codex' } })
    + line({ type: 'turn_context', payload: { model: 'fixture-codex' } })
    + line({ type: 'event_msg', timestamp: '2026-10-23T05:30:00Z', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: 200, cached_input_tokens: 50, cache_write_input_tokens: 50, output_tokens: 9999 } } } });
  const paths = [join(temporary, 'claude', 'fixture.jsonl'), join(temporary, 'codex', 'fixture.jsonl')];
  await writeFile(paths[0], claudeText); await writeFile(paths[1], codexText);
  const { GET } = await import('@/app/api/runtime/usage/route');
  const fetchMock = serve(url => GET(new NextRequest(`http://localhost${url}`, { headers: { host: 'localhost' } })));
  await mount();
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(row('Claude')?.textContent).toContain('33.3%');
  }, { timeout: 10_000 });
  expect(row('Codex')?.textContent).toContain('25%');
  expect(host.textContent).toContain('2026-10-23'); expect(host.textContent).toContain('This machine');
  expect(host.textContent).not.toContain('PRIVATE-FIXTURE'); expect(host.textContent).not.toMatch(/savings|saved|warm|cold resumes/i);
  expect(await readFile(paths[0], 'utf8')).toBe(claudeText); expect(await readFile(paths[1], 'utf8')).toBe(codexText);
  expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('/api/runtime/'))).toBe(true);
});

it('distinguishes a measured zero share, missing history, empty input and partial coverage', async () => {
  let data = snapshot();
  serve(async () => Response.json(data)); await mount();
  expect(row('Claude')?.textContent).toContain('90%'); expect(row('Codex')?.textContent).toContain('0%');
  data = { ...snapshot([bucket('claude', 10, 10)]), sources: [
    { provider: 'claude', status: 'partial', files: 1, records: 1 }, { provider: 'codex', status: 'missing', files: 0, records: 0 }] };
  await refresh(); expect(row('Claude')?.textContent).toContain('50%'); expect(row('Claude')?.textContent).toContain('Partial history');
  expect(row('Codex')?.textContent).toContain('History unavailable'); expect(row('Codex')?.textContent).not.toContain('0%');
  data = snapshot([bucket('claude', 0, 0)]); await refresh();
  expect(row('Claude')?.textContent).toContain('No input observed today'); expect(row('Claude')?.textContent).not.toContain('0%');
});

it('never presents a prior calendar day as today, including after an open view crosses midnight', async () => {
  fakeIntervals();
  let data = { ...snapshot(), until: Date.parse('2026-10-23T03:59:00Z'), observedAt: '2026-10-23T03:59:00Z' };
  serve(async () => Response.json(data)); await mount();
  expect(host.textContent).toContain('No observation for today'); expect(row('Claude')?.textContent).not.toContain('90%');
  data = snapshot(); await refresh(); expect(row('Claude')?.textContent).toContain('90%');
  vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-24T04:01:00Z'));
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(host.textContent).toContain('No observation for today'); expect(row('Claude')?.textContent).not.toContain('90%');
});

it('refreshes both observations and labels a retained cache share after history refresh fails', async () => {
  let fail = false;
  const fetchMock = serve(async () => fail ? Response.json({}, { status: 503 }) : Response.json(snapshot()));
  await mount(); expect(row('Claude')?.textContent).toContain('90%');
  fail = true; await refresh();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/capacity?fresh=1'))).toBe(true);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('machine=local&fresh=1'))).toBe(true);
  expect(host.textContent).toContain('Could not refresh this machine'); expect(row('Claude')?.textContent).toContain('90%');
});

it('makes no cache-history requests while inactive or on another view, and cleans up polling', async () => {
  fakeIntervals();
  const fetchMock = serve(async () => Response.json(snapshot()));
  await mount(false); expect(fetchMock).not.toHaveBeenCalled();
  await mount(); expect(row('Claude')?.textContent).toContain('90%');
  await mount(false); const count = fetchMock.mock.calls.length;
  await act(async () => vi.advanceTimersByTime(120_000)); expect(fetchMock).toHaveBeenCalledTimes(count);
  await mount();
  await act(async () => host.querySelector<HTMLButtonElement>('#usage-activity-tab')!.click());
  const historyCount = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/runtime/usage?')).length;
  const before = historyCount(); await act(async () => vi.advanceTimersByTime(120_000)); expect(historyCount()).toBe(before);
});
