// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';

vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: false }) }));
vi.mock('@/lib/operator/use-pr-link-destination', () => ({ usePrLinkDestinationFlag: () => 'app' }));
vi.mock('@/lib/tauri/ipc-fetch', () => ({ ipcFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
vi.mock('./orchestrator-data-context', () => ({ useOrchestratorData: () => null }));
vi.mock('./thoughts/mission-panel/useDirectiveProposals', () => ({
  useDirectiveProposals: () => ({ proposals: [], loading: false, error: null, accept: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock('./o8-panel/O8DirectiveProposalDrawer', () => ({
  O8DirectiveProposalDrawer: () => null, hydrateProposalPrefs: () => {}, markProposalsSeen: () => {}, PROPOSALS_OPEN_KEY: 'fixture-proposals',
}));
vi.mock('./o8-panel/O8ActivityMissionControls', () => ({ O8ActivityMissionControls: () => null }));
vi.mock('./o8-panel/O8ActivityPacketRow', () => ({ O8ActivityPacketRow: () => null }));
vi.mock('./o8-panel/O8ProblemDossiers', () => ({ O8ProblemDossiers: () => null }));
vi.mock('./pr-panel/PrPanel', () => ({ PrPanel: () => null }));
import { O8ActivityPane } from './O8ActivityPane';

const repoA = 'example/alpha'; const repoB = 'example/beta';
const date = '2026-10-22T12:00:00Z';
const registry = (repo: string): RepoRegistryEntry => ({
  id: repo, name: repo.split('/')[1], localPath: `/fixture/${repo}`, remoteUrl: `https://github.com/${repo}`,
  defaultBranch: 'main', addedAt: date, lastOpenedAt: null, storagePressureParkingDisabled: false,
  setup: { envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
    buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null, workspaceIsolationPreference: 'auto' },
});
const detail = (id = 11, tag = 'known') => ({
  repo: repoA, run: { databaseId: id, jobs: [{ name: `${tag} job`, conclusion: 'failure',
    steps: [{ name: `${tag} step`, conclusion: 'failure' }] }] }, logs: `prefix ##[error]${tag} error`,
});
let root: Root; let host: HTMLDivElement; let client: QueryClient;
let reply: (repo: string, id: number, init?: RequestInit) => Response | Promise<Response>;
let fetchMock: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
const reads = () => fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/panel/ci/'));
const settle = async (ms = 1) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
async function render(repos: string[] = [repoA], active = true) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...repos.map((repo, i) => createElement('section', { key: i }, createElement(O8ActivityPane, {
      active, repoSlug: repo, registeredRepos: [registry(repo)],
    }))),
  ))); await settle();
}
function row(index = 0, id = 11) {
  const section = host.querySelectorAll('section')[index];
  const button = [...section.querySelectorAll<HTMLButtonElement>('button')].find(b =>
    b.title === 'Expand activity details' && b.textContent?.includes(`Run ${id}`));
  expect(button).toBeDefined(); return button!;
}
async function toggle(index = 0, id = 11) { await act(async () => row(index, id).click()); await settle(); }
function retry() { return [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Retry CI details')!; }
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; }); return { resolve, promise };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T12:30:00Z')); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  reply = (repo, id) => Response.json({ ...detail(id), repo });
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://fixture.invalid');
    if (url.pathname.startsWith('/api/panel/ci/')) return reply(url.searchParams.get('repo')!, Number(url.pathname.split('/').pop()), init);
    if (url.pathname === '/api/panel/ci') return Response.json({ runs: [11, 12].map(databaseId => ({
      databaseId, displayTitle: `Run ${databaseId}`, status: 'completed', conclusion: 'failure', createdAt: date,
      headBranch: 'feature', workflowName: 'Build',
    })) });
    if (url.pathname === '/api/panel/prs') return Response.json({ prs: [] });
    if (url.pathname === '/api/panel/issues') return Response.json({ issues: [] });
    if (url.pathname === '/api/panel/commits') return Response.json({ commits: [] });
    if (url.pathname === '/api/panel/repos') return Response.json({ repos: [] });
    throw new Error(`Unexpected fixture read: ${input}`);
  }); vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('only reads expanded runs and shares one pending read across five real panes', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render(Array(5).fill(repoA)); expect(reads()).toHaveLength(0);
  for (let i = 0; i < 5; i++) await toggle(i);
  expect(reads()).toHaveLength(1);
  await act(async () => pending.resolve(Response.json(detail()))); await settle();
  expect(host.textContent?.match(/known job/g)).toHaveLength(5);
  expect(host.textContent?.match(/known step/g)).toHaveLength(5); expect(host.textContent?.match(/known error/g)).toHaveLength(5);
});
it('reuses fresh details after collapse and pane remount', async () => {
  await render(); await toggle(); await toggle(); await toggle();
  await render([]); await render(); await toggle();
  expect(host.textContent).toContain('known job'); expect(reads()).toHaveLength(1);
});
it('refreshes expired detail on expansion and replaces known failures with successful empty detail', async () => {
  await render(); await toggle(); await toggle(); await settle(120_000);
  reply = () => Response.json({ ...detail(), run: { databaseId: 11, jobs: [] }, logs: '' }); await toggle();
  expect(reads()).toHaveLength(2); expect(host.textContent).not.toContain('known job'); expect(host.textContent).not.toContain('known error');
});
it('does not introduce a detail poller while expanded or collapsed', async () => {
  await render(); await toggle(); await settle(300_000); expect(reads()).toHaveLength(1);
  await toggle(); await settle(300_000); expect(reads()).toHaveLength(1);
});
it.each([429, 503])('retains known detail with error, age and explicit retry after a %i', async status => {
  await render(); await toggle(); await toggle(); await settle(120_000);
  reply = () => new Response(null, { status }); await toggle();
  expect(reads()).toHaveLength(2); expect(host.textContent).toContain('known job'); expect(host.textContent).toContain('CI details delayed');
  expect(host.textContent).toMatch(/\(12\ds old\)/);
  reply = () => Response.json(detail(11, 'recovered')); await act(async () => retry().click()); await settle();
  expect(reads()).toHaveLength(3); expect(host.textContent).toContain('recovered job'); expect(host.textContent).not.toContain('known job');
  expect(host.textContent).not.toContain('CI details delayed');
});
it('shows initial failure and allows explicit retry', async () => {
  reply = () => new Response(null, { status: 503 }); await render(); await toggle();
  expect(host.textContent).toContain('CI details delayed'); expect(host.textContent).not.toContain('known job');
  reply = () => Response.json(detail()); await act(async () => retry().click()); await settle();
  expect(host.textContent).toContain('known job'); expect(reads()).toHaveLength(2);
});
it('retries an initial transient failure on the next expansion', async () => {
  reply = () => new Response(null, { status: 503 }); await render(); await toggle(); await toggle();
  reply = () => Response.json(detail()); await toggle(); expect(host.textContent).toContain('known job'); expect(reads()).toHaveLength(2);
});
it.each([403, 429])('respects a %i pause across collapse and remount but allows manual retry', async status => {
  reply = () => new Response(null, { status, headers: { 'retry-after': '300' } });
  await render(); await toggle(); await toggle(); await toggle(); await render([]); await render(); await toggle();
  expect(reads()).toHaveLength(1); expect(host.textContent).toContain('CI details delayed');
  reply = () => Response.json(detail()); await act(async () => retry().click()); await settle();
  expect(reads()).toHaveLength(2); expect(host.textContent).toContain('known job');
});
it('resumes expansion reads after the reset deadline', async () => {
  reply = () => new Response(null, { status: 429, headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 300) } });
  await render(); await toggle(); await toggle(); await settle(120_000); await toggle(); expect(reads()).toHaveLength(1);
  await toggle(); await settle(180_000); reply = () => Response.json(detail()); await toggle();
  expect(reads()).toHaveLength(2); expect(host.textContent).toContain('known job');
});
it('cancels on collapse and ignores a transport that resolves late', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render(); await toggle(); const signal = reads()[0][1]?.signal; await toggle(); expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(Response.json(detail(11, 'late')))); await settle();
  reply = () => Response.json(detail(11, 'current')); await toggle();
  expect(host.textContent).toContain('current job'); expect(host.textContent).not.toContain('late job'); expect(reads()).toHaveLength(2);
});
it('keeps a shared read until its last expanded pane closes', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render([repoA, repoA]); await toggle(0); await toggle(1); const signal = reads()[0][1]?.signal;
  await toggle(0); expect(signal?.aborted).toBe(false); await toggle(1); expect(signal?.aborted).toBe(true); expect(reads()).toHaveLength(1);
});
it('cancels when the pane deactivates and retries on reactivation', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render(); await toggle(); await render([repoA], false); expect(reads()[0][1]?.signal?.aborted).toBe(true);
  reply = () => Response.json(detail()); await render();
  expect(reads()).toHaveLength(2); expect(host.textContent).toContain('known job');
});
it('does not start detail reads for rows expanded while a pane is inactive', async () => {
  await render(); await render([repoA], false); await toggle(); expect(reads()).toHaveLength(0);
});
it('cancels when filtering the selected run out of the timeline', async () => {
  const pending = deferred(); reply = () => pending.promise;
  await render(); await toggle();
  await act(async () => host.querySelector<HTMLButtonElement>('button[title="Commits"]')!.click()); await settle();
  expect(reads()[0][1]?.signal?.aborted).toBe(true);
});
it('isolates run and repository changes from previous pending replies', async () => {
  const pending = deferred(); reply = (repo, id) => id === 11 && repo === repoA ? pending.promise : Response.json({ ...detail(id, repo), repo });
  await render(); await toggle(); await toggle(0, 12); expect(reads()[0][1]?.signal?.aborted).toBe(true);
  expect(host.textContent).toContain(`${repoA} job`); await render([repoB]); await toggle(0, 11);
  await act(async () => pending.resolve(Response.json(detail(11, 'wrong')))); await settle();
  expect(host.textContent).toContain(`${repoB} job`); expect(host.textContent).not.toContain('wrong job'); expect(host.textContent).not.toContain(`${repoA} job`);
});
it('allows Retry to supersede a pending refresh and ignores its late reply', async () => {
  await render(); await toggle(); await toggle(); await settle(120_000);
  const pending = deferred(); reply = () => pending.promise; await toggle(); const signal = reads().at(-1)![1]?.signal;
  expect(retry()).toBeDefined(); reply = () => Response.json(detail(11, 'manual')); await act(async () => retry().click()); await settle();
  expect(signal?.aborted).toBe(true); await act(async () => pending.resolve(Response.json(detail(11, 'superseded')))); await settle();
  expect(host.textContent).toContain('manual job'); expect(host.textContent).not.toContain('superseded job');
});
it.each([
  ['identity', { ...detail(), run: { ...detail().run, databaseId: 99 } }],
  ['repository', { ...detail(), repo: repoB }],
  ['body error', { error: 'unavailable' }], ['run', { run: null, logs: '' }],
  ['jobs', { ...detail(), run: { databaseId: 11, jobs: {} } }],
  ['job entry', { ...detail(), run: { databaseId: 11, jobs: [null] } }],
  ['job name', { ...detail(), run: { databaseId: 11, jobs: [{ name: {}, conclusion: 'failure' }] } }],
  ['steps', { ...detail(), run: { databaseId: 11, jobs: [{ name: 'job', conclusion: 'failure', steps: {} }] } }],
  ['step entry', { ...detail(), run: { databaseId: 11, jobs: [{ name: 'job', conclusion: 'failure', steps: [null] }] } }],
  ['logs', { ...detail(), logs: {} }],
])('rejects malformed %s before caching and recovers after reopening', async (_name, payload) => {
  reply = () => Response.json(payload); await render(); await toggle(); expect(host.textContent).toContain('CI details delayed');
  await toggle(); reply = () => Response.json(detail()); await toggle(); expect(host.textContent).toContain('known job'); expect(reads()).toHaveLength(2);
});
