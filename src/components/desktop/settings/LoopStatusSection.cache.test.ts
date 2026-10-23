// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { githubListQueryKey } from '@/lib/github-client';
import { LoopStatusSection } from './LoopStatusSection';

const body = () => ({ repo: 'example/default', prs: [
  { state: 'OPEN' }, { state: 'open' }, {}, { state: 'CLOSED' }, { state: 'MERGED' },
] });
let root: Root; let host: HTMLDivElement; let client: QueryClient;
let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
let reply: (init?: RequestInit) => Response | Promise<Response>;
let activeCron: boolean;
const reads = () => fetchMock.mock.calls.filter(([url]) => new URL(url, 'http://fixture.invalid').pathname === '/api/panel/prs');
const settle = async (ms = 1) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
async function render(count = 1) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...Array.from({ length: count }, (_, i) => createElement('section', { key: i }, createElement(LoopStatusSection))),
  ))); await settle();
}
const counts = () => [...host.querySelectorAll('section')].map(section => {
  const label = [...section.querySelectorAll('span')].find(node => node.textContent === 'Open PRs');
  return label?.nextElementSibling?.textContent ?? null;
});
const retry = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Retry PR count')!;
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; }); return { resolve, promise };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T12:30:00Z')); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); activeCron = false;
  reply = () => Response.json(body());
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://fixture.invalid');
    if (url.pathname === '/api/panel/prs') return reply(init);
    if (url.pathname === '/api/panel/loop-status') return Response.json({ ok: true, active: activeCron, jobId: 'fixture-loop', cronExpression: '*/20 * * * *' });
    if (url.pathname === '/api/lanes') return Response.json({ lanes: [{ id: 'lane', label: 'Fixture lane', status: 'running' }] });
    if (url.pathname === '/api/panel/git/log') return Response.json({ commits: [{ hash: 'abcdef123', title: 'Fixture merge', ageMs: 60_000 }] });
    throw new Error(`Unexpected fixture read: ${input}`);
  }); vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('shares one pending default-repository PR read across five real Diagnostics sections', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render(5); expect(reads()).toHaveLength(1);
  await act(async () => pending.resolve(Response.json(body()))); await settle(); expect(counts()).toEqual(Array(5).fill('3'));
});
it('reuses a fresh default snapshot on remount without reading again', async () => {
  await render(); await render(0); await render(); expect(counts()).toEqual(['3']); expect(reads()).toHaveLength(1);
});
it('keeps the parameterless default scope distinct from explicit and disabled empty-repository caches', async () => {
  client.setQueryData(githubListQueryKey('', 'prs'), { repo: null, prs: Array(41).fill({ state: 'OPEN' }) });
  client.setQueryData(githubListQueryKey('example/default', 'prs'), { repo: 'example/default', prs: [] });
  await render(); expect(counts()).toEqual(['3']); expect(reads()).toHaveLength(1);
  expect(reads()[0][0]).toBe('/api/panel/prs');
});
it('loads cron, lanes and disclosure while the PR read is still pending', async () => {
  const pending = deferred(); reply = () => pending.promise; await render();
  expect(host.textContent).toContain('No active loop'); expect(counts()).toEqual(['—']);
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Recent merges'))!;
  await act(async () => button.click()); expect(host.textContent).toContain('Fixture merge');
  await act(async () => pending.resolve(Response.json(body()))); await settle();
  expect(counts()).toEqual(['3']); expect(host.textContent).toContain('Fixture merge');
});
it('refreshes visible counts at two minutes and accepts an empty list without resetting disclosure', async () => {
  const start = Date.now(); await render();
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Recent merges'))!.click());
  reply = () => Response.json({ repo: 'example/default', prs: [] });
  await settle(120_000 - (Date.now() - start) - 1); expect(reads()).toHaveLength(1);
  await settle(2); expect(reads()).toHaveLength(2); expect(counts()).toEqual(['0']); expect(host.textContent).toContain('Fixture merge');
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/panel/loop-status')).toHaveLength(1);
});
it('uses five-minute polling while hidden and stops after unmount', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); await render(); await settle(120_000); expect(reads()).toHaveLength(1);
  await settle(180_001); expect(reads()).toHaveLength(2);
  await render(0); await settle(300_000); expect(reads()).toHaveLength(2);
});
it.each([429, 503])('retains count with error, age and Retry after a %i background read', async status => {
  await render(); reply = () => new Response(null, { status }); await settle(120_001);
  expect(counts()).toEqual(['3']); expect(host.textContent).toContain('PR count delayed'); expect(host.textContent).toMatch(/\(12\ds old\)/);
  reply = () => Response.json({ repo: 'example/default', prs: [] }); await act(async () => retry().click()); await settle();
  expect(counts()).toEqual(['0']); expect(host.textContent).not.toContain('PR count delayed'); expect(reads()).toHaveLength(3);
});
it.each([false, true])('shows unknown on initial failure with cron active=%s and recovers', async active => {
  activeCron = active; reply = () => new Response(null, { status: 503 }); await render();
  expect(counts()).toEqual(['—']); expect(host.textContent).toContain('PR count delayed');
  reply = () => Response.json(body()); await act(async () => retry().click()); await settle(); expect(counts()).toEqual(['3']);
});
it('retries an initial transient failure after remount', async () => {
  reply = () => new Response(null, { status: 503 }); await render(); await render(0);
  reply = () => Response.json(body()); await render(); expect(reads()).toHaveLength(2); expect(counts()).toEqual(['3']);
});
it.each([403, 429])('backs off %i across remount but allows explicit Retry', async status => {
  reply = () => new Response(null, { status, headers: { 'retry-after': '300' } }); await render(); await render(0); await render();
  expect(reads()).toHaveLength(1); expect(counts()).toEqual(['—']);
  reply = () => Response.json(body()); await act(async () => retry().click()); await settle(); expect(reads()).toHaveLength(2); expect(counts()).toEqual(['3']);
});
it('resumes after the rate-limit reset deadline without requesting early', async () => {
  reply = () => new Response(null, { status: 429, headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 300) } });
  await render(); await settle(240_000); expect(reads()).toHaveLength(1);
  reply = () => Response.json(body()); await settle(60_001); expect(reads()).toHaveLength(2);
  await settle(); expect(counts()).toEqual(['3']);
});
it('cancels the last observer and prevents an ignored late response from seeding the cache', async () => {
  const pending = deferred(); reply = () => pending.promise; await render(); const signal = reads()[0][1]?.signal;
  await render(0); expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(Response.json(body()))); await settle(); reply = () => Response.json({ repo: 'example/default', prs: [] });
  await render(); expect(counts()).toEqual(['0']); expect(reads()).toHaveLength(2);
});
it('keeps the shared request until its final section unmounts', async () => {
  const pending = deferred(); reply = () => pending.promise; await render(2); const signal = reads()[0][1]?.signal;
  await render(1); expect(signal?.aborted).toBe(false); await render(0); expect(signal?.aborted).toBe(true); expect(reads()).toHaveLength(1);
});
it('lets manual Retry supersede a pending background read and ignores its late reply', async () => {
  await render(); const pending = deferred(); reply = () => pending.promise; await settle(120_001); const signal = reads().at(-1)![1]?.signal;
  reply = () => Response.json({ repo: 'example/default', prs: [] }); expect(retry()).toBeDefined();
  await act(async () => retry().click()); await settle(); expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(Response.json(body()))); await settle(); expect(counts()).toEqual(['0']); expect(reads()).toHaveLength(3);
});
it.each([
  ['body', null], ['error', { ...body(), error: 'unavailable' }], ['unavailable', { repo: null, prs: [], unavailable: true }],
  ['list', { ...body(), prs: {} }], ['entry', { ...body(), prs: [null] }], ['state', { ...body(), prs: [{ state: {} }] }],
])('rejects malformed or unavailable %s, then recovers on Retry', async (_name, payload) => {
  reply = () => Response.json(payload); await render(); expect(counts()).toEqual(['—']); expect(host.textContent).toContain('PR count delayed');
  reply = () => Response.json(body()); await act(async () => retry().click()); await settle(); expect(counts()).toEqual(['3']);
});
