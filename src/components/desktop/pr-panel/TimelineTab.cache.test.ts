// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueryClient } from '@/lib/query/client';
import { PrCommentComposer } from './PrCommentComposer';
import { invalidateSWR } from '@/lib/panel/fetch-cache';
import { GITHUB_LIST_FRESH_MS } from '@/lib/github-client';
import { TimelineTab } from './tabs/TimelineTab';
import type { PrDetail, PrTimelineEvent } from './types';

function detail(number: number): PrDetail {
  return { number, title: `Change ${number}`, body: '', state: 'open', author: 'author', headRefName: 'work', baseRefName: 'main', additions: 0, deletions: 0, changedFiles: 0, createdAt: '', updatedAt: '', closedAt: null, mergedAt: null, mergeable: false, reviewDecision: null, statusCheckRollup: [], url: `https://github.com/example/repo/pull/${number}`, files: [], reviewComments: [], issueComments: [] };
}
const event = (id = 'comment:1', body = 'Known discussion'): PrTimelineEvent => ({ id, kind: 'commented', title: 'commented', actor: 'reviewer', avatarUrl: null, at: '2026-10-20T10:00:00Z', body, url: 'https://github.com/example/repo/pull/7' });
const page = (events = [event()], nextPage: number | null = null) => Response.json({ events, nextPage });
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>(finish => { resolve = finish; });
  return { promise, resolve };
}
type Selection = { repo?: string | null; number?: number; active?: boolean };
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}
async function render(selections: Selection[] = [{ repo: 'Org/Sample' }], composer?: Selection) {
  await act(async () => root.render(createElement(QueryClientProvider, { client }, ...selections.map((selection, index) => createElement(TimelineTab, { key: index, detail: detail(selection.number ?? 7), repoSlug: selection.repo, active: selection.active ?? true, newestFirst: false, onToggleOrder: () => {}, onOpenFile: () => {} })), composer ? createElement(PrCommentComposer, { detail: detail(composer.number ?? 7), repoSlug: composer.repo, draft: 'Posted comment', onDraftChange: () => {}, onCollapse: () => {} }) : null)));
  await flush();
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  await flush();
}
const reads = () => fetchMock.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  invalidateSWR('pr-timeline');
  client = getQueryClient(); client.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  fetchMock = vi.fn(async () => page()); vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear(); invalidateSWR('pr-timeline'); host.remove();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('PR timeline shared snapshots through TimelineTab', () => {
  it('joins concurrent repository aliases and keeps the original request spelling', async () => {
    const held = deferred(); fetchMock.mockReturnValue(held.promise);
    await render([{ repo: 'Org/Sample' }, { repo: 'org/sample' }]);
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toContain('repo=Org%2FSample');
    await act(async () => held.resolve(page())); await flush();
    expect(host.querySelectorAll('[aria-label="Pull request timeline"]')).toHaveLength(2);
    expect(host.textContent?.match(/Known discussion/g)).toHaveLength(2);
  });

  it('reuses a warm snapshot across remounts and aliases for the shared freshness window', async () => {
    await render(); await render([]);
    await act(async () => vi.advanceTimersByTimeAsync(90_000));
    await render([{ repo: 'org/sample' }]);
    expect(reads()).toHaveLength(1); expect(host.textContent).toContain('Known discussion');
  });

  it('does not poll while mounted and refreshes on reopening after shared freshness expires', async () => {
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(GITHUB_LIST_FRESH_MS + 1));
    expect(reads()).toHaveLength(1);
    await render([]); fetchMock.mockResolvedValue(page([event('new', 'Fresh discussion')]));
    await render();
    expect(reads()).toHaveLength(2); expect(host.textContent).toContain('Fresh discussion');
  });

  it.each(['http', 'json', 'network', 'api', 'shape', 'row', 'cursor', 'quota'])('retains known activity on %s refresh failure and recovers with Retry', async kind => {
    await render();
    if (kind === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'));
    else fetchMock.mockResolvedValueOnce(kind === 'http' ? Response.json({}, { status: 503 })
      : kind === 'json' ? new Response('invalid-json')
      : kind === 'api' ? Response.json({ error: 'Activity unavailable', events: [], nextPage: null })
      : kind === 'shape' ? Response.json({ events: {}, nextPage: null })
      : kind === 'row' ? Response.json({ events: [{ ...event(), title: {} }], nextPage: null })
      : kind === 'cursor' ? Response.json({ events: [], nextPage: 0 })
      : Response.json({ error: 'GitHub refresh is paused.' }, { status: 429, headers: { 'retry-after': '120' } }));
    await click('Refresh');
    expect(host.textContent).toContain('Known discussion');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).toContain('Last successful activity read');
    fetchMock.mockResolvedValue(page([event('new', 'Recovered discussion')]));
    await click('Retry activity');
    expect(host.textContent).toContain('Recovered discussion');
    expect(host.textContent).not.toContain('Known discussion');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('retries an initial failure without treating it as an empty timeline', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Activity unavailable', events: [], nextPage: null }));
    await render();
    expect(host.querySelector('[aria-label="Pull request timeline"]')).toBeNull();
    expect(host.textContent).not.toContain('Last successful activity read');
    await click('Retry activity'); expect(host.textContent).toContain('Known discussion');
  });

  it('accepts a successful empty refresh as authoritative', async () => {
    await render(); fetchMock.mockResolvedValueOnce(page([])); await click('Refresh');
    expect(host.textContent).not.toContain('Known discussion');
    expect(host.querySelectorAll('[aria-label="Pull request timeline"] li')).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('merges and deduplicates pages, retaining the latest copy of an event', async () => {
    fetchMock.mockResolvedValueOnce(page([event()], 2)).mockResolvedValueOnce(page([event('comment:1', 'Updated first comment'), event('comment:2', 'Second comment')]));
    await render(); await click('Load more activity');
    expect(reads().at(-1)).toContain('page=2');
    expect(host.querySelectorAll('[aria-label="Pull request timeline"] li')).toHaveLength(3);
    expect(host.textContent).toContain('Updated first comment'); expect(host.textContent).toContain('Second comment');
    expect(host.textContent).not.toContain('Load more activity');
  });

  it('keeps loaded pages after pagination failure and retries the failed page', async () => {
    fetchMock.mockResolvedValueOnce(page([event()], 2)).mockResolvedValueOnce(Response.json({ error: 'Page unavailable', events: [], nextPage: null }));
    await render(); await click('Load more activity');
    expect(host.textContent).toContain('Known discussion');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    fetchMock.mockResolvedValueOnce(page([event('second', 'Second page')]));
    await click('Retry activity');
    expect(reads().at(-1)).toContain('page=2');
    expect(host.textContent).toContain('Known discussion'); expect(host.textContent).toContain('Second page');
  });

  it('keeps both loaded pages when refreshing fails and Retry refreshes from page one', async () => {
    fetchMock.mockResolvedValueOnce(page([event()], 2)).mockResolvedValueOnce(page([event('second', 'Second page')]));
    await render(); await click('Load more activity');
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await click('Refresh');
    expect(host.textContent).toContain('Known discussion'); expect(host.textContent).toContain('Second page');
    fetchMock.mockResolvedValueOnce(page([event('fresh', 'Fresh first page')]));
    await click('Retry activity');
    expect(reads().at(-1)).toContain('page=1');
    expect(host.textContent).toContain('Fresh first page'); expect(host.textContent).not.toContain('Second page');
  });

  it.each([{ repo: 'org/other', number: 7 }, { repo: 'Org/Sample', number: 8 }, { repo: null, number: 7 }])('isolates another repository, PR or default scope: %j', async selection => {
    await render(); const held = deferred(); fetchMock.mockReturnValueOnce(held.promise);
    await render([selection]);
    expect(host.textContent).not.toContain('Known discussion');
    expect(host.textContent).toContain('Loading activity');
    await act(async () => held.resolve(page([event('other', 'Other selection')]))); await flush();
    expect(host.textContent).toContain('Other selection');
    await render(); expect(host.textContent).toContain('Known discussion'); expect(host.textContent).not.toContain('Other selection');
  });

  it('aborts a superseded scope and ignores late replies even when transport ignores abort', async () => {
    const held = deferred(); fetchMock.mockReturnValueOnce(held.promise);
    await render(); const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    await render([{ repo: 'org/other' }]); expect(signal.aborted).toBe(true);
    await act(async () => held.resolve(page([event('old', 'Obsolete discussion')]))); await flush();
    expect(host.textContent).not.toContain('Obsolete discussion');
    fetchMock.mockResolvedValue(page([event('fresh', 'Current discussion')]));
    await render(); expect(host.textContent).toContain('Current discussion');
    expect(host.textContent).not.toContain('Obsolete discussion'); expect(reads()).toHaveLength(3);
  });

  it('keeps inactive panels idle and reuses a warm result on reactivation', async () => {
    await render([{ repo: 'Org/Sample', active: false }]); expect(reads()).toHaveLength(0);
    await render(); expect(reads()).toHaveLength(1);
    await render([{ repo: 'Org/Sample', active: false }]); await render(); expect(reads()).toHaveLength(1);
  });

  it('aborts the read when its last observer unmounts', async () => {
    fetchMock.mockReturnValue(deferred().promise); await render();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    await render([]); expect(signal.aborted).toBe(true);
  });

  it('keeps a shared read alive while another alias observer remains', async () => {
    const held = deferred(); fetchMock.mockReturnValue(held.promise);
    await render([{ repo: 'Org/Sample' }, { repo: 'org/sample' }]);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    await render([{ repo: 'org/sample' }]); expect(signal.aborted).toBe(false); expect(reads()).toHaveLength(1);
    await act(async () => held.resolve(page())); await flush(); expect(host.textContent).toContain('Known discussion');
  });
});


describe('confirmed comment refresh through the timeline and comment composer', () => {
  it('invalidates an inactive timeline across repository aliases without repeating the write', async () => {
    await render();
    await render([], { repo: 'org/sample' });
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    fetchMock.mockResolvedValue(page([event('posted', 'Posted discussion')]));
    await render();
    expect(host.textContent).toContain('Posted discussion');
    expect(host.textContent).not.toContain('Known discussion');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(2);
  });

  it('cancels a pre-comment refresh and shares the fresh read across active aliases', async () => {
    await render([{ repo: 'Org/Sample' }, { repo: 'org/sample' }], { repo: 'Org/Sample' });
    const held = deferred(); let firstRead = true;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(Response.json({ ok: true }));
      if (firstRead) { firstRead = false; return held.promise; }
      return Promise.resolve(page([event('posted', 'Posted discussion')]));
    });
    await click('Refresh');
    const oldSignal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(oldSignal.aborted).toBe(true);
    expect(host.textContent?.match(/Posted discussion/g)).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(3);
    await act(async () => held.resolve(page([event('old', 'Pre-comment discussion')]))); await flush();
    expect(host.textContent).not.toContain('Pre-comment discussion');
  });
});
