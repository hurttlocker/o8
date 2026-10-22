// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ControlRoomTab } from '../ControlRoomTab';
import type { RepoFocusRepo } from '../../types';

const sample: RepoFocusRepo = { id: 'sample', name: 'Sample', localPath: '/workspace/sample', remoteUrl: 'https://github.com/org/sample.git', defaultBranch: 'main' };
const other: RepoFocusRepo = { id: 'other', name: 'Other', localPath: '/workspace/other', remoteUrl: 'git@github.com:org/other.git', defaultBranch: 'main' };
const sampleRepos = [sample];
const project = { id: 'fixture-project', name: 'Fixture', repoPaths: [sample.localPath, other.localPath], createdAt: '2026-01-01T00:00:00Z' };
const issue = (title = 'Repair fixture', number = 7) => ({ number, title, state: 'OPEN', body: '  Preserve source context.  ',
  labels: ['bug'], comments: 2, updatedAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', url: `https://github.com/org/sample/issues/${number}` });
const list = (title = 'Repair fixture', number = 7, repo = 'org/sample') => Response.json({ repo, issues: [issue(title, number)] });
let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/panel/issues?'));
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
function nonIssues(url: string, init?: RequestInit) {
  if (init?.method === 'POST') return Response.json({ ok: true, taskId: 'fixture-task', note: 'Fixture task saved' });
  return Response.json(url.startsWith('/api/tasks?') ? { tasks: [] } : { items: [] });
}
async function settle(ms = 0) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function show(count = 1, repos = sampleRepos, selectedRepo: RepoFocusRepo | null = null) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...Array.from({ length: count }, (_, key) => createElement(ControlRoomTab, { key, project, repos, selectedRepo })),
  ))); await settle(); await settle();
}
const intake = () => [...host.querySelectorAll('section')].find(section => section.textContent?.includes('GitHub intake'))!;
const refresh = async () => { await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh GitHub intake"]')!.click()); await settle(); await settle(); };
const button = (label: string, index = 0) => [...intake().querySelectorAll('button')].filter(node => node.textContent === label)[index]!;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?') ? list() : nonIssues(url, init));
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('shares one issue read across five real Control Rooms', async () => {
  await show(5); expect(host.textContent?.match(/Repair fixture/g)).toHaveLength(5);
  expect(reads()).toHaveLength(1);
});
it('reuses a fresh list on remount', async () => {
  await show(); await show(0); await show(); expect(intake().textContent).toContain('Repair fixture');
  expect(reads()).toHaveLength(1);
});
it('reads no GitHub list when the project has no repositories', async () => {
  await show(1, []); expect(reads()).toHaveLength(0); expect(writes()).toHaveLength(0);
});
it('preserves selected scope after delayed replies from the previous repository', async () => {
  let release!: () => void;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => !url.startsWith('/api/panel/issues?') ? Promise.resolve(nonIssues(url, init))
    : url.includes('org%2Fsample') ? new Promise<Response>(resolve => { release = () => resolve(list()); })
    : Promise.resolve(list('Other issue', 9, 'org/other')));
  const repos = [sample, other]; await show(1, repos, sample); await show(1, repos, other);
  expect(intake().textContent).toContain('Other issue');
  await act(async () => release()); await settle();
  expect(intake().textContent).not.toContain('Repair fixture');
  await act(async () => button('Queue').click()); await settle();
  expect(JSON.parse(writes()[0][1].body)).toMatchObject({ repoPath: other.localPath, sourceIssue: { number: 9 } });
});
it('drops previous-scope rows immediately while the next list is pending', async () => {
  const repos = [sample, other]; await show(1, repos, sample);
  fetchMock.mockImplementation((url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?') ? new Promise<Response>(() => {}) : Promise.resolve(nonIssues(url, init)));
  await show(1, repos, other); expect(intake().textContent).not.toContain('Repair fixture');
  expect(intake().textContent).toContain('Loading project issues');
});
it('deduplicates a shared remote while preserving both registered checkout destinations', async () => {
  const second = { ...sample, id: 'second', name: 'Second checkout', localPath: '/workspace/second' };
  const errors = vi.spyOn(console, 'error');
  await show(1, [sample, second]); expect(reads()).toHaveLength(1);
  expect(intake().textContent?.match(/Repair fixture/g)).toHaveLength(2);
  expect(errors.mock.calls.some(args => args.some(value => String(value).includes('same key')))).toBe(false);
  await act(async () => button('Queue', 1).click()); await settle();
  expect(JSON.parse(writes()[0][1].body)).toMatchObject({ repoPath: second.localPath });
});
it('keeps display-name fallback caches separate between checkouts', async () => {
  const first = { ...sample, name: 'Alias', remoteUrl: null };
  const second = { ...first, id: 'second', localPath: '/workspace/second' };
  await show(1, [first]);
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?') ? list('Second alias read') : nonIssues(url, init));
  await show(1, [second]); expect(intake().textContent).toContain('Second alias read'); expect(reads()).toHaveLength(2);
});
it('keeps successful repositories visible when another initial read fails', async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?')
    ? url.includes('org%2Fother') ? new Response('unavailable', { status: 503 }) : list() : nonIssues(url, init));
  await show(1, [sample, other]); expect(intake().textContent).toContain('Repair fixture');
  expect(intake().textContent).toContain('Other:'); expect(reads()).toHaveLength(2);
});
it('retains known intake rows after a failed explicit refresh', async () => {
  await show();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?') ? new Response('rate limited', { status: 429 }) : nonIssues(url, init));
  await refresh(); expect(intake().textContent).toContain('Repair fixture'); expect(intake().textContent).toContain('Sample:');
  expect(button('Queue')).toBeDefined(); expect(reads()).toHaveLength(2);
});
it('retries an initial failure using the real intake refresh control', async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?') ? new Response('unavailable', { status: 503 }) : nonIssues(url, init));
  await show(); expect(intake().textContent).toContain('Sample:');
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?') ? list() : nonIssues(url, init));
  await refresh(); expect(intake().textContent).toContain('Repair fixture');
  expect(reads().at(-1)?.[0]).toContain('fresh=1');
});
it('cancels an older read when manual refresh requests a fresh snapshot', async () => {
  await show(); let release!: () => void; let pending!: Promise<void>;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?')
    ? new Promise<Response>(resolve => { release = () => resolve(list('Older reply')); }) : Promise.resolve(nonIssues(url, init)));
  await act(async () => { pending = client.invalidateQueries(); }); const oldRead = reads().at(-1);
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?') ? list('Fresh reply') : nonIssues(url, init));
  await refresh(); expect(reads().at(-1)?.[0]).toContain('fresh=1'); expect(oldRead?.[1]?.signal.aborted).toBe(true);
  await act(async () => { release(); await pending; }); await settle();
  expect(intake().textContent).toContain('Fresh reply'); expect(intake().textContent).not.toContain('Older reply');
});
it('observes visible refreshes at two minutes and stops after unmount', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); await show();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?') ? list('Updated intake') : nonIssues(url, init));
  await settle(2 * 60_000 + 1); await settle(); expect(intake().textContent).toContain('Updated intake'); expect(reads()).toHaveLength(2);
  await show(0); await settle(5 * 60_000); expect(reads()).toHaveLength(2);
});
it('observes the shared five-minute interval while hidden', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); await show();
  await settle(2 * 60_000 + 1); expect(reads()).toHaveLength(1);
  await settle(3 * 60_000); expect(reads()).toHaveLength(2);
});
it.each(['Queue', 'Dispatch'])('preserves the local destination and normalized epic context through %s', async action => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?')
    ? Response.json({ repo: 'org/other', issues: [{ ...issue('  Epic fixture  ', 9), number: '9', labels: [{ name: 'epic' }, null], comments: '2' }] })
    : nonIssues(url, init));
  await show(1, [other]); await act(async () => button(action).click()); await settle(); await settle();
  const created = JSON.parse(writes()[0][1].body);
  expect(created).toEqual({ title: '#9 - Epic fixture', summary: 'Preserve source context.\n\nSource: https://github.com/org/sample/issues/9',
    projectId: project.id, repoPath: other.localPath, workerIntent: 'orchestrator', requestedRuntime: 'codex',
    sourceIssue: { number: 9, body: 'Preserve source context.', url: 'https://github.com/org/sample/issues/9' } });
  expect(writes()).toHaveLength(action === 'Dispatch' ? 2 : 1);
  if (action === 'Dispatch') {
    expect(writes()[1][0]).toBe('/api/tasks/fixture-task/dispatch');
    expect(JSON.parse(writes()[1][1].body)).toEqual({ actor: 'orchestrator', projectId: project.id, repoPath: other.localPath, message: 'Dispatch GitHub epic #9 from org/other.' });
  }
  expect(reads()).toHaveLength(2); expect(reads().at(-1)?.[0]).toContain('fresh=1');
});
it('preserves normalization, newest-first sorting and selected/all scope limits', async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.startsWith('/api/panel/issues?')
    ? Response.json({ repo: 'org/sample', issues: [{ number: 'bad', title: 'Invalid number' }, { number: 99, title: ' ' },
      ...Array.from({ length: 25 }, (_, index) => ({ ...issue(`  Item ${index + 1}  `, index + 1), updatedAt: new Date(Date.UTC(2026, 9, index + 1)).toISOString() }))] })
    : nonIssues(url, init));
  await show(1, sampleRepos, sample);
  const more = [...intake().querySelectorAll('button')].find(node => node.textContent?.includes('more issues'))!;
  await act(async () => more.click());
  expect(intake().querySelectorAll('[title="Open issue on GitHub"]')).toHaveLength(10);
  expect(intake().textContent).not.toContain('Invalid number'); expect(intake().textContent).not.toContain('#99');
  expect(intake().querySelector('[title="Open issue on GitHub"]')?.textContent).toContain('Item 25');
  await show(1, sampleRepos); expect(intake().querySelectorAll('[title="Open issue on GitHub"]')).toHaveLength(18);
});
