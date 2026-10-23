// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IssueViewer } from './IssueViewer';
import type { CanvasRepoTaskLaunchRequest } from './canvas-utils';

const repoA = 'org/alpha';
const repoB = 'org/beta';
const issue = (repo = repoA, number = 7, title = `Issue ${repo} ${number}`, state = 'open') => ({
  number, title, state, body: `Body ${repo} ${number}`, labels: [{ name: 'bug', color: 'abcdef' }],
  author: 'fixture', createdAt: '2026-10-22T12:00:00Z', comments: 2, url: `https://github.com/${repo}/issues/${number}`,
});
const snapshot = (repo = repoA, number = 7, title?: string, state?: string) => Response.json({ repo, issue: issue(repo, number, title, state) });
const registry = (repo = repoA, state = 'ready') => ({
  name: repo.split('/').pop(), localPath: `/workspace/${repo.split('/').pop()}`, remoteUrl: `https://github.com/${repo}.git`,
  readiness: { state, label: state === 'missing' ? 'Folder missing' : 'Ready', summary: `Readiness ${repo}`, currentBranch: 'main' },
});
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let launch: Mock<(request: CanvasRepoTaskLaunchRequest) => Promise<void>>;
const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/panel/issues/'));
const settle = async (ms = 0) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
async function render(count = 1, repo: string | null = repoA, issueNumber = 7) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...Array.from({ length: count }, (_, key) => createElement(IssueViewer, { key, repo: repo ?? undefined, issueNumber, onLaunchWorkspaceTask: launch })),
  )));
  await settle(); await settle();
}
async function invalidate() { await act(async () => { await client.invalidateQueries(); }); await settle(); await settle(); }
async function click(label: string) {
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === label)!.click());
  await settle(); await settle();
}
function deferred<T = Response>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T12:30:00Z')); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  launch = vi.fn<(request: CanvasRepoTaskLaunchRequest) => Promise<void>>(async () => {});
  fetchMock = vi.fn(async (input: string) => {
    if (input === '/api/panel/repos') return Response.json({ repos: [registry(repoA), registry(repoB)] });
    const url = new URL(input, 'https://fixture.invalid');
    return snapshot(url.searchParams.get('repo') ?? repoA, Number(url.pathname.split('/').pop()));
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('shared issue details through the real IssueViewer', () => {
  it('shares one detail read across five viewers and renders the real content', async () => {
    await render(5); expect(reads()).toHaveLength(1);
    expect(host.querySelectorAll('h2')).toHaveLength(5);
    expect(host.textContent?.match(/Body org\/alpha 7/g)).toHaveLength(5);
    expect(host.querySelector('a')?.getAttribute('href')).toBe(`https://github.com/${repoA}/issues/7`);
    expect(host.textContent).toContain('2 comments'); expect(host.textContent).toContain('bug');
  });

  it('reuses a fresh snapshot across remounts and repository casing', async () => {
    await render(); await render(0); await render(1, ' ORG/ALPHA ');
    expect(reads()).toHaveLength(1); expect(host.textContent).toContain(`Issue ${repoA} 7`);
  });

  it('preserves repository spelling in the read and workspace-launch contract', async () => {
    const repo = 'Org/CaseRepo';
    fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [registry(repo)] }) : snapshot(repo));
    await render(1, repo);
    expect(new URL(reads()[0][0], 'https://fixture.invalid').searchParams.get('repo')).toBe(repo);
    expect(host.textContent).toContain(`Readiness ${repo}`);
    await click('Launch In Workspace'); expect(launch.mock.calls[0][0].repo).toBe(repo);
  });

  it('refreshes stale details on remount without adding polling', async () => {
    await render(); await settle(180_000); expect(reads()).toHaveLength(1);
    await render(0); fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot(repoA, 7, 'Updated issue'));
    await render(); expect(reads()).toHaveLength(2); expect(host.textContent).toContain('Updated issue');
  });

  it('revalidates a closed issue on stale remount so a reopened issue can update', async () => {
    fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot(repoA, 7, 'Closed issue', 'closed'));
    await render(); await render(0); await settle(180_000);
    fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot(repoA, 7, 'Reopened issue'));
    await render(); expect(reads()).toHaveLength(2); expect(host.textContent).toContain('Reopened issue');
  });

  it('switches repositories at the same issue number and launches the displayed issue', async () => {
    await render(); await render(1, repoB);
    expect(host.textContent).toContain(`Issue ${repoB} 7`); expect(host.textContent).not.toContain(`Body ${repoA} 7`);
    await click('Launch In Workspace');
    expect(launch).toHaveBeenCalledWith({ kind: 'issue', repo: repoB, number: 7, title: `Issue ${repoB} 7`, body: `Body ${repoB} 7` });
    expect(reads()).toHaveLength(2);
  });

  it('isolates issue numbers and reuses the previous issue on returning', async () => {
    await render(); await render(1, repoA, 8);
    expect(host.textContent).toContain(`Issue ${repoA} 8`);
    await render(); expect(host.textContent).toContain(`Issue ${repoA} 7`); expect(reads()).toHaveLength(2);
  });

  it('hides the previous issue and launch action while another repository loads', async () => {
    await render(); const pending = deferred();
    fetchMock.mockImplementation(input => input === '/api/panel/repos' ? Promise.resolve(Response.json({ repos: [] })) : pending.promise);
    await render(1, repoB);
    expect(host.textContent).toContain('Loading issue #7'); expect(host.textContent).not.toContain(`Body ${repoA} 7`);
    expect(host.querySelector('button')).toBeNull();
    await act(async () => pending.resolve(snapshot(repoB))); await settle();
    expect(host.textContent).toContain(`Issue ${repoB} 7`);
  });

  it('aborts an old repository read and prevents its late response from populating the new scope', async () => {
    const pending = deferred(); fetchMock.mockImplementationOnce(() => pending.promise);
    await render(); const signal = reads()[0][1]?.signal;
    await render(1, repoB); expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(snapshot(repoA, 7, 'Late old issue'))); await settle();
    expect(host.textContent).toContain(`Issue ${repoB} 7`); expect(host.textContent).not.toContain('Late old issue');
    await render(); expect(reads()).toHaveLength(3); expect(host.textContent).toContain(`Issue ${repoA} 7`);
  });

  it('keeps the omitted-repository lookup separate and does not add a workspace action', async () => {
    await render(2, null); expect(reads()).toHaveLength(1); expect(reads()[0][0]).toBe('/api/panel/issues/7');
    expect(host.querySelector('button')).toBeNull();
    await render(2); expect(reads()).toHaveLength(2);
  });

  it.each(['http', 'api', 'json', 'identity', 'network', 'shape'] as const)('retains known details after a %s refresh failure, shows age and retries', async failure => {
    await render(2); await settle(60_000);
    fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [] })
      : failure === 'http' ? new Response(null, { status: 429 })
        : failure === 'api' ? Response.json({ error: 'Unavailable' })
          : failure === 'json' ? new Response('not JSON')
            : failure === 'network' ? Promise.reject(new Error('offline'))
              : failure === 'shape' ? Response.json({ issue: { ...issue(), labels: null } }) : snapshot(repoA, 99));
    await invalidate(); expect(host.querySelectorAll('h2')).toHaveLength(2);
    expect(host.textContent).toContain(`Body ${repoA} 7`);
    expect(host.textContent).toContain('Showing last successful issue'); expect(host.textContent).toContain('1m ago');
    fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot(repoA, 7, 'Recovered issue'));
    await click('Retry'); expect(host.textContent?.match(/Recovered issue/g)).toHaveLength(2); expect(reads()).toHaveLength(3);
    expect(host.textContent).not.toContain('Showing last successful issue');
  });

  it('retries an initially failed issue read through the actual Retry button', async () => {
    fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [] }) : new Response(null, { status: 503 }));
    await render(); expect(host.textContent).toContain('Failed to load issue #7'); expect(host.querySelector('h2')).toBeNull();
    fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot());
    await click('Retry'); expect(host.textContent).toContain(`Issue ${repoA} 7`); expect(reads()).toHaveLength(2);
  });

  it('continues to accept the existing unwrapped detail response', async () => {
    fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [] }) : Response.json(issue()));
    await render(); expect(host.textContent).toContain(`Issue ${repoA} 7`);
  });

  it('preserves the missing-folder launch gate', async () => {
    fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [registry(repoA, 'missing')] }) : snapshot());
    await render(); const button = host.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent).toBe('Folder missing'); expect(button.disabled).toBe(true);
    await act(async () => button.click()); expect(launch).not.toHaveBeenCalled();
  });

  it('does not let late readiness from the previous repository disable the current launch', async () => {
    const pending = deferred();
    fetchMock.mockImplementationOnce(async () => snapshot());
    fetchMock.mockImplementationOnce(() => pending.promise);
    await render(); const signal = fetchMock.mock.calls.find(([url]) => url === '/api/panel/repos')![1]?.signal;
    await render(1, repoB);
    await act(async () => pending.resolve(Response.json({ repos: [registry(repoA, 'missing')] })));
    expect(signal?.aborted).toBe(true); expect(host.textContent).not.toContain('Folder missing');
    await click('Launch In Workspace'); expect(launch.mock.calls[0][0].repo).toBe(repoB);
  });

  it('keeps launch UI state scoped when an old launch settles after a new one starts', async () => {
    const old = deferred<void>(), current = deferred<void>();
    launch.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    await render(); await click('Launch In Workspace'); expect(host.textContent).toContain('Launching…');
    await render(1, repoB); await click('Launch In Workspace');
    await act(async () => old.resolve()); expect(host.textContent).toContain('Launching…');
    expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    await act(async () => current.resolve()); expect(host.textContent).toContain('Launch In Workspace');
    expect(launch.mock.calls.map(([request]) => request.repo)).toEqual([repoA, repoB]);
  });

  it('keeps a shared request until the last viewer unmounts, then aborts it', async () => {
    const pending = deferred();
    fetchMock.mockImplementation(input => input === '/api/panel/repos' ? Promise.resolve(Response.json({ repos: [] })) : pending.promise);
    await render(2); const signal = reads()[0][1]?.signal;
    await render(1); expect(signal?.aborted).toBe(false);
    await render(0); expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(snapshot()));
  });

  it('lets Retry supersede an older background read and keeps the newer result', async () => {
    await render();
    fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [] }) : new Response(null, { status: 429 }));
    await invalidate();
    const pending = deferred(); fetchMock.mockImplementationOnce(() => pending.promise);
    let background!: Promise<void>;
    await act(async () => { background = client.invalidateQueries(); });
    const signal = reads().at(-1)![1]?.signal;
    fetchMock.mockImplementation(async input => input === '/api/panel/repos' ? Response.json({ repos: [] }) : snapshot(repoA, 7, 'Newest issue'));
    await click('Retry'); expect(signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(snapshot(repoA, 7, 'Superseded issue')); await background; });
    await settle(); expect(host.textContent).toContain('Newest issue'); expect(host.textContent).not.toContain('Superseded issue');
  });
});
