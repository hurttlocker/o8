// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { ActivityFeed } from './ActivityFeed';

const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl }));
const repoA = 'example/alpha';
const repoB = 'example/beta';
const date = '2026-10-22T12:00:00Z';
const body = (id = 7, label = 'Known') => ({ run: { databaseId: id, jobs: [{
  name: `${label} job`, conclusion: 'failure', steps: [{ name: `${label} step`, conclusion: 'failure' }],
}] }, logs: `prefix ##[error]${label} error` });
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let reply: (repo: string, id: number, init?: RequestInit) => Response | Promise<Response>;
let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
const reads = () => fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/panel/ci/'));
const settle = async (ms = 1) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
async function render(repos: string[] = [repoA]) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...repos.map((repo, key) => createElement('section', { key }, createElement(ActivityFeed, {
      events: [], commits: [], agents: [], activeRepo: repo,
    }))),
  ))); await settle();
}
function row(index = 0, id = 7) {
  const title = [...host.querySelectorAll('section')[index].querySelectorAll('div')].find(node => node.textContent === `Run ${id}`)!;
  expect(title).toBeDefined(); return title.parentElement!.parentElement!;
}
async function hover(index = 0, id = 7, open = true) {
  await act(async () => row(index, id).dispatchEvent(new MouseEvent(open ? 'mouseover' : 'mouseout', {
    bubbles: true, relatedTarget: document.body,
  })));
  await settle(open ? 1 : 150);
}
const retry = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Retry CI details')!;
const expectSummary = (label = 'Known') => {
  for (const text of ['job', 'step', 'error']) expect(document.body.textContent).toContain(`${label} ${text}`);
};
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { resolve, promise };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T12:30:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 200, 40));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  reply = (_repo, id) => Response.json(body(id));
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://fixture.invalid');
    if (url.pathname.startsWith('/api/panel/ci/')) return reply(url.searchParams.get('repo')!, Number(url.pathname.split('/').pop()), init);
    if (url.pathname === '/api/panel/repos') return Response.json({ repos: [] });
    if (url.pathname === '/api/panel/ci') return Response.json({ runs: [7, 8].map(id => ({
      databaseId: id, displayTitle: `Run ${id}`, createdAt: date, headBranch: 'feature', workflowName: 'Build', status: 'completed', conclusion: 'failure',
    })) });
    if (url.pathname === '/api/panel/issues') return Response.json({ issues: [] });
    if (url.pathname === '/api/panel/prs') return Response.json({ prs: [] });
    if (url.pathname === '/api/panel/commits') return Response.json({ commits: [] });
    throw new Error(`Unexpected fixture read: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock); openExternalUrl.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('reads only hovered runs and shares one pending read across five real feeds', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render(Array(5).fill(repoA)); expect(reads()).toHaveLength(0);
  for (let i = 0; i < 5; i++) await hover(i);
  expect(reads()).toHaveLength(1);
  await act(async () => pending.resolve(Response.json(body()))); await settle();
  expect(document.body.textContent?.match(/Known step/g)).toHaveLength(5);
});
it('reuses fresh summaries across reopen, remount and repository casing', async () => {
  await render(); await hover(); await hover(0, 7, false); await hover();
  await render([]); await render([' EXAMPLE/ALPHA ']); await hover();
  expectSummary(); expect(reads()).toHaveLength(1);
});
it('refreshes stale summaries on reopen and accepts authoritative empty detail', async () => {
  await render(); await hover(); await hover(0, 7, false); await settle(120_000);
  reply = () => Response.json({ run: { databaseId: 7, jobs: [] }, logs: '' }); await hover();
  expect(reads()).toHaveLength(2); expect(document.body.textContent).not.toContain('Known job');
  expect(document.body.textContent).not.toContain('Known error'); expect(document.body.textContent).not.toContain('CI details delayed');
});
it('does not poll open or closed hover details', async () => {
  await render(); await hover(); await settle(300_000); expect(reads()).toHaveLength(1);
  await hover(0, 7, false); await settle(300_000); expect(reads()).toHaveLength(1);
});
it.each(['http', 'network', 'json', 'api'])('retains a known summary and age after a %s failure, then retries', async kind => {
  await render(); await hover(); await hover(0, 7, false); await settle(120_000);
  reply = () => {
    if (kind === 'network') throw new Error('Fixture offline');
    return kind === 'http' ? new Response(null, { status: 429 }) : kind === 'json' ? new Response('invalid-json') : Response.json({ error: 'Unavailable' });
  };
  await hover(); expectSummary(); expect(document.body.textContent).toContain('CI details delayed');
  expect(document.body.textContent).toMatch(/\(12\ds old\)/);
  reply = () => Response.json(body(7, 'Recovered')); await act(async () => retry().click()); await settle();
  expectSummary('Recovered'); expect(document.body.textContent).not.toContain('Known job'); expect(reads()).toHaveLength(3);
});
it('offers initial recovery and retries an ordinary failed read on the next hover', async () => {
  reply = () => new Response(null, { status: 503 }); await render(); await hover();
  expect(document.body.textContent).toContain('CI details delayed'); expect(retry()).toBeDefined();
  await hover(0, 7, false); reply = () => Response.json(body()); await hover(); expectSummary(); expect(reads()).toHaveLength(2);
});
it.each([
  { status: 429, header: 'retry-after', value: '90' },
  { status: 403, header: 'retry-after', value: 'Thu, 22 Oct 2026 12:31:30 GMT' },
  { status: 429, header: 'x-ratelimit-reset', value: String(Date.parse('2026-10-22T12:31:30Z') / 1000) },
])('backs off $status/$header across reopen and remount, while allowing Retry', async ({ status, header, value }) => {
  reply = () => new Response(null, { status, headers: { [header]: value } });
  await render(); await hover(); await hover(0, 7, false); await hover(); await render([]); await render(); await hover();
  expect(reads()).toHaveLength(1); expect(document.body.textContent).toContain('CI details delayed');
  reply = () => Response.json(body()); await act(async () => retry().click()); await settle(); expectSummary(); expect(reads()).toHaveLength(2);
});
it('recovers an already-open hover automatically after the quota deadline', async () => {
  reply = () => new Response(null, { status: 429, headers: { 'retry-after': '30' } });
  await render(); await hover(); reply = () => Response.json(body());
  await settle(31_000); await settle(); expectSummary(); expect(reads()).toHaveLength(2);
});
it('aborts on final close, ignores late replies and retries when reopened', async () => {
  const pending = deferred(); reply = () => pending.promise; await render(); await hover();
  const signal = reads()[0][1]?.signal; await hover(0, 7, false); expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(Response.json(body(7, 'Obsolete')))); await settle();
  reply = () => Response.json(body()); await hover(); expectSummary(); expect(document.body.textContent).not.toContain('Obsolete job');
  expect(reads()).toHaveLength(2);
});
it('keeps a shared read alive until its last hover closes', async () => {
  const pending = deferred(); reply = () => pending.promise; await render([repoA, repoA]); await hover(0); await hover(1);
  const signal = reads()[0][1]?.signal; await hover(0, 7, false); expect(signal?.aborted).toBe(false);
  await hover(1, 7, false); expect(signal?.aborted).toBe(true);
});
it('isolates runs and repositories and ignores delayed prior selections', async () => {
  const pending = deferred(); reply = (repo, id) => id === 7 && repo === repoA ? pending.promise : Response.json(body(id, `${repo}-${id}`));
  await render(); await hover(); await hover(0, 8); expectSummary(`${repoA}-8`); expect(reads()[0][1]?.signal?.aborted).toBe(true);
  await render([repoB]); await hover(); await act(async () => pending.resolve(Response.json(body(7, 'Wrong')))); await settle();
  expectSummary(`${repoB}-7`); expect(document.body.textContent).not.toContain('Wrong job');
});
it('cancels a hover filtered out of the real timeline', async () => {
  const pending = deferred(); reply = () => pending.promise; await render(); await hover();
  const filter = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Commits'))!;
  await act(async () => filter.click()); await settle(); expect(reads()[0][1]?.signal?.aborted).toBe(true);
});
it('lets Retry supersede an in-flight refresh without accepting its late reply', async () => {
  await render(); await hover(); await hover(0, 7, false); await settle(120_000);
  const pending = deferred(); reply = () => pending.promise; await hover(); const signal = reads().at(-1)![1]?.signal;
  expect(retry()).toBeDefined(); reply = () => Response.json(body(7, 'Manual'));
  await act(async () => retry().click()); await settle(); expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(Response.json(body(7, 'Superseded')))); await settle();
  expectSummary('Manual'); expect(document.body.textContent).not.toContain('Superseded job');
});
it.each([
  ['wrong run', body(99)], ['wrong repository', { ...body(), repo: repoB }], ['non-object', null],
  ['jobs', { run: { databaseId: 7, jobs: {} }, logs: '' }],
  ['job name', { run: { databaseId: 7, jobs: [{ name: {} }] }, logs: '' }],
  ['steps', { run: { databaseId: 7, jobs: [{ name: 'Bad', steps: [null] }] }, logs: '' }],
  ['step outcome', { run: { databaseId: 7, jobs: [{ name: 'Bad', steps: [{ name: 'Step', conclusion: {} }] }] }, logs: '' }],
  ['logs', { ...body(), logs: {} }],
])('rejects malformed %s before caching, then recovers on reopen', async (_name, payload) => {
  reply = () => Response.json(payload); await render(); await hover(); expect(document.body.textContent).toContain('CI details delayed');
  await hover(0, 7, false); reply = () => Response.json(body()); await hover(); expectSummary(); expect(reads()).toHaveLength(2);
});
it('preserves the real Open Run action', async () => {
  await render(); await hover(); const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Open Run')!;
  await act(async () => button.click()); expect(openExternalUrl).toHaveBeenCalledWith(`https://github.com/${repoA}/actions/runs/7`);
});
