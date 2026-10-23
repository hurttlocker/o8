// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { GITHUB_LIST_FRESH_MS } from '@/lib/github-client';
import { CIViewer } from './CanvasCIViewer';

const run = (id: number, title = `Run ${id}`) => ({ databaseId: id, displayTitle: title, event: 'push', headBranch: 'work', headSha: 'a'.repeat(40), status: 'completed', conclusion: 'failure', createdAt: '2026-10-22T12:00:00Z', updatedAt: '2026-10-22T12:01:00Z', workflowName: 'Build', url: 'https://example.invalid/run' });
const annotation = { path: 'src/example.ts', startLine: 7, endLine: 7, level: 'failure', message: 'Known annotation', title: 'Type check', rawDetails: '', blobUrl: 'https://example.invalid/file' };
const payload = (id = 11, label = 'Known', repo = 'org/sample') => ({ repo, run: { ...run(id, `${label} detail ${id}`), jobs: [{ databaseId: 1, name: `${label} job`, status: 'completed', conclusion: 'failure', startedAt: '', completedAt: '', annotations: [annotation] }], annotations: [{ ...annotation, message: `${label} annotation` }], botComments: [{ id: 2, prNumber: 7, kind: 'issue', author: 'automation', body: `${label} comment`, createdAt: '', url: 'https://example.invalid/comment' }] }, logs: `${label} logs ${id}` });
const detail = (id = 11, label = 'Known', repo = 'org/sample') => Response.json(payload(id, label, repo));
function deferred() { let resolve!: (r: Response) => void; const promise = new Promise<Response>(finish => { resolve = finish; }); return { promise, resolve }; }
type Selection = { repo?: string; runId?: number };
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); }); }
async function render(selections: Selection[] = [{ repo: 'org/sample', runId: 11 }]) {
  await act(async () => root.render(createElement(QueryClientProvider, { client }, ...selections.map((s, key) => createElement(CIViewer, { key, repo: s.repo, initialRunId: s.runId })))));
  await flush();
}
async function invalidate() { await act(async () => { await client.invalidateQueries({ predicate: q => q.queryKey[2] === 'ci-run' }); }); await flush(); }
async function retry() {
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Retry run details"]'); expect(button).not.toBeNull();
  await act(async () => button!.click()); await flush();
}
const reads = () => fetchMock.mock.calls.filter(([input]) => new URL(String(input), 'https://fixture.invalid').pathname.startsWith('/api/panel/ci/'));
function expectSnapshot(label = 'Known', id = 11) {
  for (const value of [`${label} detail ${id}`, `${label} job`, `${label} annotation`, `${label} comment`, `${label} logs ${id}`]) expect(host.textContent).toContain(value);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T12:30:00Z')); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async (input: string) => {
    const url = new URL(input, 'https://fixture.invalid');
    return url.pathname === '/api/panel/ci' ? Response.json({ repo: url.searchParams.get('repo') ?? 'org/default', runs: [run(11), run(12)] }) : detail(Number(url.pathname.split('/').pop()), 'Known', url.searchParams.get('repo') ?? 'org/default');
  });
  vi.stubGlobal('fetch', fetchMock); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Canvas CI shared detail snapshots through the real viewer', () => {
  it('joins concurrent aliases and preserves the original detail request spelling', async () => {
    const held = deferred(); const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? held.promise : transport(input));
    await render([{ repo: 'Org/Sample', runId: 11 }, { repo: 'org/sample', runId: 11 }]);
    expect(reads()).toHaveLength(1); expect(reads()[0][0]).toBe('/api/panel/ci/11?repo=Org%2FSample');
    await act(async () => held.resolve(detail())); await flush(); expect(host.textContent?.match(/Known logs 11/g)).toHaveLength(2);
  });

  it('reuses a warm run on remount and repository aliases', async () => {
    await render(); await render([]); await act(async () => vi.advanceTimersByTimeAsync(90_000));
    await render([{ repo: 'ORG/SAMPLE', runId: 11 }]); expect(reads()).toHaveLength(1); expectSnapshot();
  });

  it('reuses a warm run when selecting another run and returning', async () => {
    await render(); await render([{ repo: 'org/sample', runId: 12 }]); expectSnapshot('Known', 12);
    await render(); expectSnapshot(); expect(reads()).toHaveLength(2);
  });

  it('refreshes on reopening after shared freshness expires', async () => {
    await render(); await render([]); await act(async () => vi.advanceTimersByTimeAsync(GITHUB_LIST_FRESH_MS + 1));
    const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? Promise.resolve(detail(11, 'Fresh')) : transport(input));
    await render(); expectSnapshot('Fresh'); expect(reads()).toHaveLength(2);
  });

  it.each(['http', 'network', 'json', 'api', 'identity', 'repo', 'jobs', 'annotation', 'comment', 'logs'])('retains the complete known snapshot after a %s refresh failure and recovers with Retry', async kind => {
    await render(); const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string) => {
      if (!String(input).startsWith('/api/panel/ci/')) return transport(input);
      if (kind === 'network') throw new Error('offline');
      if (kind === 'http') return new Response(null, { status: 429 });
      if (kind === 'json') return new Response('invalid-json');
      const data = payload(11, 'Invalid');
      return Response.json(kind === 'api' ? { ...data, error: 'Unavailable' }
        : kind === 'identity' ? payload(12, 'Wrong run')
        : kind === 'repo' ? { ...data, repo: 'org/other' }
        : kind === 'jobs' ? { ...data, run: { ...data.run, jobs: {} } }
        : kind === 'annotation' ? { ...data, run: { ...data.run, annotations: [null] } }
        : kind === 'comment' ? { ...data, run: { ...data.run, botComments: [{ ...data.run.botComments[0], body: {} }] } }
        : { ...data, logs: {} });
    });
    await act(async () => vi.advanceTimersByTimeAsync(60_000)); await invalidate();
    expectSnapshot(); expect(host.textContent).toContain('Showing last successful run details'); expect(host.textContent).toContain('1m ago');
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? Promise.resolve(detail(11, 'Recovered')) : transport(input));
    await retry(); expectSnapshot('Recovered'); expect(host.textContent).not.toContain('Showing last successful run details');
  });

  it('offers Retry after an initial failed read without inventing empty detail', async () => {
    const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? Promise.resolve(Response.json({ error: 'Unavailable' }, { status: 503 })) : transport(input));
    await render(); expect(host.textContent).toContain('Unable to load run details'); expect(host.textContent).not.toContain('Showing last successful');
    fetchMock.mockImplementation(transport); await retry(); expectSnapshot();
  });

  it('accepts successful empty jobs, annotations, comments and logs', async () => {
    await render(); const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? Promise.resolve(Response.json({ run: { ...run(11, 'Empty detail'), jobs: [], annotations: [], botComments: [] }, logs: '' })) : transport(input));
    await invalidate(); expect(host.textContent).toContain('Empty detail');
    for (const text of ['Known job', 'Known annotation', 'Known comment', 'Known logs']) expect(host.textContent).not.toContain(text);
    expect(host.textContent).not.toContain('Showing last successful');
  });

  it.each([{ repo: 'org/other', runId: 11 }, { repo: 'org/sample', runId: 12 }, { runId: 11 }])('isolates another repository, run or default lookup: %j', async selection => {
    await render(); const held = deferred(); const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? held.promise : transport(input));
    await render([selection]); expect(host.textContent).not.toContain('Known logs'); expect(host.textContent).toContain('Loading run details');
    await act(async () => held.resolve(detail(selection.runId, 'Other', selection.repo ?? 'org/default'))); await flush(); expectSnapshot('Other', selection.runId);
    await render(); expectSnapshot(); expect(host.textContent).not.toContain('Other logs'); expect(reads()).toHaveLength(2);
  });

  it('aborts abandoned detail and ignores late replies without seeding stale snapshots', async () => {
    const held = deferred(); const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/11') ? held.promise : transport(input));
    await render(); const oldSignal = reads()[0][1]?.signal as AbortSignal;
    await render([{ repo: 'org/sample', runId: 12 }]); expect(oldSignal.aborted).toBe(true);
    await act(async () => held.resolve(detail(11, 'Obsolete'))); await flush(); expect(host.textContent).not.toContain('Obsolete');
    fetchMock.mockImplementation(transport); await render(); expectSnapshot(); expect(reads()).toHaveLength(3);
  });

  it('keeps one shared detail read alive until its last observer unmounts', async () => {
    const held = deferred(); const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? held.promise : transport(input));
    await render([{ repo: 'org/sample', runId: 11 }, { repo: 'org/sample', runId: 11 }]); expect(reads()).toHaveLength(1);
    const signal = reads()[0][1]?.signal as AbortSignal;
    await render(); expect(signal.aborted).toBe(false); await render([]); expect(signal.aborted).toBe(true);
  });

  it('keeps known detail in place during a pending refresh and lets Retry supersede it', async () => {
    await render(); const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? Promise.resolve(new Response(null, { status: 503 })) : transport(input));
    await invalidate(); const held = deferred();
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? held.promise : transport(input));
    let background!: Promise<void>; await act(async () => { background = client.invalidateQueries({ predicate: q => q.queryKey[2] === 'ci-run' }); }); await flush();
    expectSnapshot(); expect(host.textContent).not.toContain('Loading run details'); const signal = reads().at(-1)![1]?.signal as AbortSignal;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? Promise.resolve(detail(11, 'Retried')) : transport(input));
    await retry(); expect(signal.aborted).toBe(true); expectSnapshot('Retried');
    await act(async () => { held.resolve(detail(11, 'Superseded')); await background; }); await flush(); expect(host.textContent).not.toContain('Superseded');
  });
});


it('supports a registered repository name and shares its resolved detail with the explicit slug', async () => {
  fetchMock.mockImplementation(async (input: string) => new URL(input, 'https://fixture.invalid').pathname === '/api/panel/ci'
    ? Response.json({ repo: 'org/sample', runs: [run(11), run(12)] }) : detail());
  await render([{ repo: 'Sample', runId: 11 }]); expectSnapshot();
  expect(reads()[0][0]).toBe('/api/panel/ci/11?repo=Sample');
  await render([{ repo: 'Org/Sample', runId: 11 }]); expectSnapshot(); expect(reads()).toHaveLength(1);
});

describe('Canvas CI detail quota recovery through the real viewer', () => {
  const retryCases: Array<{ label: string; status: number; headers: () => HeadersInit; delay: number }> = [
    { label: 'numeric Retry-After', status: 429, headers: () => ({ 'retry-after': '90' }), delay: 90_000 },
    { label: 'HTTP-date Retry-After', status: 403, headers: () => ({ 'retry-after': new Date(Date.now() + 90_000).toUTCString() }), delay: 90_000 },
    { label: 'primary reset', status: 403, headers: () => ({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.now() / 1000 + 90) }), delay: 90_000 },
    { label: 'later reset than Retry-After', status: 429, headers: () => ({ 'retry-after': '10', 'x-ratelimit-reset': String(Date.now() / 1000 + 90) }), delay: 90_000 },
    { label: 'missing deadline', status: 429, headers: () => ({}), delay: 60_000 },
    { label: 'invalid deadline', status: 429, headers: () => ({ 'retry-after': 'invalid' }), delay: 60_000 },
  ];

  it.each(retryCases)('pauses initial reads across remounts and resumes mounted observers at $label', async ({ status, headers, delay }) => {
    const transport = fetchMock.getMockImplementation()!;
    const refusal = new Response(null, { status, headers: headers() });
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? Promise.resolve(refusal) : transport(input));
    await render(); expect(reads()).toHaveLength(1);
    expect(host.textContent).toContain('Unable to load run details');
    await render([]); await act(async () => vi.advanceTimersByTimeAsync(delay - 1000));
    await render([{ repo: 'org/sample', runId: 11 }, { repo: 'ORG/SAMPLE', runId: 11 }]);
    expect(reads()).toHaveLength(1);
    await invalidate(); expect(reads()).toHaveLength(1);
    fetchMock.mockImplementation(transport);
    await act(async () => vi.advanceTimersByTimeAsync(1100)); await flush();
    expect(reads()).toHaveLength(2); expectSnapshot();
    expect(host.textContent?.match(/Known logs 11/g)).toHaveLength(2);
  });

  it('keeps the full snapshot and its age during backoff and refreshes after the deadline', async () => {
    await render(); const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/')
      ? Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '90' } })) : transport(input));
    await invalidate(); expect(reads()).toHaveLength(2); expectSnapshot();
    await render([]); await act(async () => vi.advanceTimersByTimeAsync(60_000)); await render();
    expect(reads()).toHaveLength(2); expectSnapshot();
    expect(host.textContent).toContain('Showing last successful run details'); expect(host.textContent).toContain('1m ago');
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/') ? Promise.resolve(detail(11, 'Recovered')) : transport(input));
    await act(async () => vi.advanceTimersByTimeAsync(30_100)); await flush();
    expect(reads()).toHaveLength(3); expectSnapshot('Recovered');
    expect(host.textContent).not.toContain('Showing last successful run details');
  });

  it('lets explicit Retry bypass an unexpired pause', async () => {
    const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/')
      ? Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '90' } })) : transport(input));
    await render(); fetchMock.mockImplementation(transport); await retry();
    expectSnapshot(); expect(reads()).toHaveLength(2);
  });

  it('isolates pauses by repository and run', async () => {
    const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/')
      ? Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '90' } })) : transport(input));
    await render(); fetchMock.mockImplementation(transport);
    await render([{ repo: 'org/other', runId: 11 }]); expectSnapshot();
    await render([{ repo: 'org/sample', runId: 12 }]); expectSnapshot('Known', 12);
    await render(); expect(reads()).toHaveLength(3); expect(host.textContent).toContain('Unable to load run details');
  });

  it.each([false, true])('does not turn an ordinary permission refusal into a quota pause (quota headers: %s)', async withHeaders => {
    const transport = fetchMock.getMockImplementation()!;
    const headers: HeadersInit = withHeaders ? { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(Date.now() / 1000 + 90) } : {};
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/')
      ? Promise.resolve(new Response(null, { status: 403, headers })) : transport(input));
    await render(); await render([]); fetchMock.mockImplementation(transport); await render();
    expectSnapshot(); expect(reads()).toHaveLength(2);
  });

  it('honors a second refusal while the same viewer stays mounted', async () => {
    const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/')
      ? Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '30' } })) : transport(input));
    await render(); expect(reads()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(30_100)); await flush(); expect(reads()).toHaveLength(2);
    await invalidate(); expect(reads()).toHaveLength(2);
    fetchMock.mockImplementation(transport);
    await act(async () => vi.advanceTimersByTimeAsync(30_100)); await flush();
    expect(reads()).toHaveLength(3); expectSnapshot();
  });

  it('does no detail work after closing and fetches once when reopened after the pause', async () => {
    const transport = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => String(input).startsWith('/api/panel/ci/')
      ? Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '30' } })) : transport(input));
    await render(); await render([]);
    await act(async () => vi.advanceTimersByTimeAsync(31_000)); expect(reads()).toHaveLength(1);
    fetchMock.mockImplementation(transport); await render(); expect(reads()).toHaveLength(2); expectSnapshot();
  });
});
