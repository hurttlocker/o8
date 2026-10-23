// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { ActivityFeed } from './ActivityFeed';

const repoA = 'example/alpha';
const repoB = 'example/beta';
const date = '2026-10-22T12:00:00Z';
const body = (number = 7, path = 'known.ts') => ({
  number, mergeable: true, checksStatus: 'success', reviewDecision: null,
  files: [{ path, status: 'modified', additions: 5, deletions: 2 }],
});
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let reply: (repo: string, number: number, init?: RequestInit) => Response | Promise<Response>;
let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
const select = vi.fn(); const review = vi.fn(); const launch = vi.fn();
const reads = () => fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/panel/pr?'));
const settle = async (ms = 1) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
async function render(repos: string[] = [repoA]) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...repos.map((repo, i) => createElement('section', { key: i }, createElement(ActivityFeed, {
      events: [], commits: [], agents: [], activeRepo: repo, onSelectPR: select, onReviewPR: review, onLaunchTask: launch,
    }))),
  ))); await settle();
}
function row(index = 0, number = 7) {
  const section = host.querySelectorAll('section')[index];
  const title = [...section.querySelectorAll('div')].find(node => node.textContent === `#${number} Pull ${number}`)!;
  expect(title).toBeDefined();
  return title.parentElement!.parentElement!;
}
async function hover(index = 0, number = 7, open = true) {
  await act(async () => row(index, number).dispatchEvent(new MouseEvent(open ? 'mouseover' : 'mouseout', {
    bubbles: true, relatedTarget: document.body,
  })));
  await settle(open ? 1 : 150);
}
function retry() {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Retry PR details')!;
}
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
  reply = (_repo, number) => Response.json(body(number));
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://fixture.invalid');
    if (url.pathname === '/api/panel/pr') return reply(url.searchParams.get('repo')!, Number(url.searchParams.get('number')), init);
    if (url.pathname === '/api/panel/repos') return Response.json({ repos: [] });
    if (url.pathname === '/api/panel/prs') return Response.json({ prs: [7, 8].map(number => ({
      number, title: `Pull ${number}`, state: 'OPEN', createdAt: date, author: { login: 'fixture' },
      headRefName: 'feature', changedFiles: 1, statusCheckRollup: [],
    })) });
    if (url.pathname === '/api/panel/issues') return Response.json({ issues: [] });
    if (url.pathname === '/api/panel/ci') return Response.json({ runs: [] });
    if (url.pathname === '/api/panel/commits') return Response.json({ commits: [] });
    throw new Error(`Unexpected fixture read: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  select.mockClear(); review.mockClear(); launch.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('only reads hovered PRs and shares a pending read across five production feeds', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render(Array(5).fill(repoA)); expect(reads()).toHaveLength(0);
  for (let i = 0; i < 5; i++) await hover(i);
  expect(reads()).toHaveLength(1);
  await act(async () => pending.resolve(Response.json(body()))); await settle();
  expect(document.body.textContent?.match(/known.ts/g)).toHaveLength(5);
});
it('reuses a fresh snapshot on hover reopen and feed remount', async () => {
  await render(); await hover(); await hover(0, 7, false); await hover();
  await render([]); await render(); await hover();
  expect(document.body.textContent).toContain('known.ts'); expect(reads()).toHaveLength(1);
});
it('refreshes an expired snapshot on reopen and replaces old files with a successful empty result', async () => {
  await render(); await hover(); await hover(0, 7, false); await settle(120_000);
  reply = () => Response.json({ ...body(), files: [], checksStatus: 'failure' });
  await hover();
  expect(reads()).toHaveLength(2); expect(document.body.textContent).not.toContain('known.ts');
  expect(document.body.textContent).toContain('ci red');
});
it('does not poll detail in an open or closed hover', async () => {
  await render(); await hover(); await settle(300_000);
  expect(reads()).toHaveLength(1);
  await hover(0, 7, false); await settle(300_000); expect(reads()).toHaveLength(1);
});
it('retains known detail after a 429, shows its age and recovers with explicit retry', async () => {
  await render(); await hover(); await hover(0, 7, false); await settle(120_000);
  reply = () => new Response(null, { status: 429 }); await hover();
  expect(reads()).toHaveLength(2); expect(document.body.textContent).toContain('known.ts');
  expect(document.body.textContent).toContain('PR details delayed');
  expect(document.body.textContent).toMatch(/\(12\ds old\)/);
  reply = () => Response.json(body(7, 'recovered.ts'));
  await act(async () => retry().click()); await settle();
  expect(reads()).toHaveLength(3); expect(document.body.textContent).toContain('recovered.ts');
  expect(document.body.textContent).not.toContain('known.ts'); expect(document.body.textContent).not.toContain('PR details delayed');
});
it('shows an initial failure and retries instead of inventing successful detail', async () => {
  reply = () => new Response(null, { status: 503 }); await render(); await hover();
  expect(document.body.textContent).toContain('PR details delayed');
  expect(document.body.textContent).not.toContain('merge ready');
  reply = () => Response.json(body()); await act(async () => retry().click()); await settle();
  expect(document.body.textContent).toContain('known.ts'); expect(reads()).toHaveLength(2);
});
it('retries a failed initial read on the next hover', async () => {
  reply = () => new Response(null, { status: 503 }); await render(); await hover(); await hover(0, 7, false);
  reply = () => Response.json(body()); await hover();
  expect(reads()).toHaveLength(2); expect(document.body.textContent).toContain('known.ts');
});
it.each([403, 429])('backs off a %i across reopen and remount while allowing explicit retry', async (status) => {
  reply = () => new Response(null, { status, headers: { 'retry-after': '300' } });
  await render(); await hover(); expect(reads()).toHaveLength(1);
  await hover(0, 7, false); await hover(); await render([]); await render(); await hover();
  expect(reads()).toHaveLength(1); expect(document.body.textContent).toContain('PR details delayed');
  reply = () => Response.json(body()); await act(async () => retry().click()); await settle();
  expect(reads()).toHaveLength(2); expect(document.body.textContent).toContain('known.ts');
});
it('resumes automatic hover reads after the rate-limit reset deadline', async () => {
  reply = () => new Response(null, { status: 429, headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 300) } });
  await render(); await hover(); await hover(0, 7, false); await settle(120_000); await hover();
  expect(reads()).toHaveLength(1);
  await hover(0, 7, false); await settle(180_000); reply = () => Response.json(body()); await hover();
  expect(reads()).toHaveLength(2); expect(document.body.textContent).toContain('known.ts');
});
it('aborts the last observer on close and ignores a transport that resolves after cancellation', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render(); await hover(); const signal = reads()[0][1]?.signal;
  await hover(0, 7, false); expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(Response.json(body(7, 'late.ts')))); await settle();
  reply = () => Response.json(body(7, 'current.ts')); await hover();
  expect(reads()).toHaveLength(2); expect(document.body.textContent).not.toContain('late.ts');
  expect(document.body.textContent).toContain('current.ts');
});
it('does not abort a shared read until the final hover closes', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render([repoA, repoA]); await hover(0); await hover(1);
  const signal = reads()[0][1]?.signal; await hover(0, 7, false);
  expect(signal?.aborted).toBe(false);
  await act(async () => pending.resolve(Response.json(body()))); await settle();
  expect(document.body.textContent).toContain('known.ts'); expect(reads()).toHaveLength(1);
});
it('separates repositories and PR numbers, including a delayed previous selection', async () => {
  const pending = deferred(); reply = (repo, number) => number === 7 && repo === repoA
    ? pending.promise : Response.json(body(number, `${repo}-${number}.ts`));
  await render(); await hover(); await hover(0, 8);
  expect(reads()[0][1]?.signal?.aborted).toBe(true);
  expect(document.body.textContent).toContain(`${repoA}-8.ts`);
  await render([repoB]); await hover(0, 7);
  await act(async () => pending.resolve(Response.json(body(7, 'wrong-repo.ts')))); await settle();
  expect(document.body.textContent).toContain(`${repoB}-7.ts`);
  expect(document.body.textContent).not.toContain('wrong-repo.ts');
  expect(document.body.textContent).not.toContain(`${repoA}-8.ts`);
});
it('cancels detail when filtering the hovered PR out of the rendered timeline', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render(); await hover();
  const filter = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Commits'))!;
  await act(async () => filter.click()); await settle();
  expect(reads()[0][1]?.signal?.aborted).toBe(true);
  expect(document.body.textContent).not.toContain('Pull Request');
});
it('lets manual retry supersede an in-flight refresh and ignores its late reply', async () => {
  await render(); await hover(); await hover(0, 7, false); await settle(120_000);
  const pending = deferred(); reply = () => pending.promise; await hover();
  expect(retry()).toBeDefined(); const signal = reads().at(-1)![1]?.signal;
  reply = () => Response.json(body(7, 'manual.ts'));
  await act(async () => retry().click()); await settle();
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(Response.json(body(7, 'superseded.ts')))); await settle();
  expect(document.body.textContent).toContain('manual.ts'); expect(document.body.textContent).not.toContain('superseded.ts');
});
it.each([
  ['wrong PR', { ...body(), number: 99 }],
  ['wrong repository', { ...body(), repo: repoB }],
  ['body error', { error: 'unavailable' }],
  ['non-object', null],
  ['merge state', { ...body(), mergeable: 'yes' }],
  ['checks state', { ...body(), checksStatus: {} }],
  ['review decision', { ...body(), reviewDecision: {} }],
  ['file collection', { ...body(), files: {} }],
  ['file entry', { ...body(), files: [null] }],
  ['file counters', { ...body(), files: [{ path: 'wrong.ts', status: 'modified', additions: {}, deletions: 2 }] }],
])('rejects malformed %s before caching and recovers on reopening', async (_name, payload) => {
  reply = () => Response.json(payload); await render(); await hover();
  expect(document.body.textContent).toContain('PR details delayed');
  expect(document.body.textContent).not.toContain('merge ready');
  await hover(0, 7, false); reply = () => Response.json(body()); await hover();
  expect(document.body.textContent).toContain('known.ts'); expect(reads()).toHaveLength(2);
});
it('preserves hover review, full-PR and launch actions', async () => {
  await render(); await hover();
  for (const label of ['Review', 'Open full PR', 'Launch review']) {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent === label)!;
    await act(async () => button.click());
  }
  expect(review).toHaveBeenCalledWith(7, repoA); expect(select).toHaveBeenCalledWith(7, repoA);
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr', repo: repoA, number: 7 }));
});
