// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { O8ThreadsPane } from './O8ThreadsPane';
import { O8HeaderTabs } from './O8HeaderTabs';
import { ThreadDetail } from './ThreadDetail';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';

const context = vi.hoisted(() => ({
  activeProjectId: 'project', agents: [], missionState: { packets: [] }, onSelectSession: vi.fn(),
}));
const projectState = vi.hoisted(() => ({
  activeProject: { id: 'project', name: 'Project', repoPaths: ['/repo'] },
  ledger: { projects: [{ id: 'project', name: 'Project', repoPaths: ['/repo'] }, { id: 'focused-project', name: 'Focused project', repoPaths: ['/other'] }] },
  loading: false,
}));
vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => context }));
vi.mock('../repo-registry/useProjects', () => ({ useProjects: () => projectState }));
vi.mock('@/lib/tauri/ipc-fetch', () => ({ ipcFetch: (...args: unknown[]) => fetch(...args as Parameters<typeof fetch>) }));

const repo = { id: 'repo', name: 'Repo', localPath: '/repo', defaultBranch: 'main', remoteUrl: null } as RepoRegistryEntry;
const task = (id: string, group: TaskPoolTask['group'] = 'running', repoPath = '/repo') => ({
  id, packetId: `packet-${id}`, title: id, summary: 'Recorded summary', group, status: group === 'done' ? 'completed' : group,
  runtime: 'cloud', repoPath, project: { id: 'project' }, lastEventLabel: 'remote_job_completed',
  workerRouting: { selectedRuntime: 'cloud', selectedModel: 'gpt-6.1-sol', selectedEffort: 'medium' },
  lane: { sessionKey: `session-${id}` },
} as TaskPoolTask);
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

describe('contextual thread panel navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    context.onSelectSession.mockClear();
    fetchMock = vi.fn(async () => json({ tasks: [task('Live'), task('Finished', 'done'), { ...task('Other', 'running', '/other'), project: { id: 'focused-project' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const show = async (repoPath = '/repo', active = true) => {
    await act(async () => { root.render(createElement(O8ThreadsPane, { active, repoPath, repos: [repo, { ...repo, localPath: '/other' }] })); });
  };
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label)!;

  it('opens Threads through the panel header, without changing the workspace', async () => {
    const onTabChange = vi.fn();
    await act(async () => root.render(createElement(O8HeaderTabs, { activeTab: 'workspace', onTabChange })));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Panel view: Workspace"]')!.click());
    const entry = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes('Threads') && node.getAttribute('role') === 'menuitem');
    expect(entry).toBeDefined();
    act(() => entry!.click());
    expect(onTabChange).toHaveBeenCalledWith('threads');
    expect(context.onSelectSession).not.toHaveBeenCalled();
  });

  it('groups scoped tasks, collapses resolved, and reads detail without replacing a session', async () => {
    await show();
    expect(container.textContent).toContain('gpt-6.1-sol · medium');
    expect(container.textContent).not.toContain('remote_job_completed');
    expect(container.querySelector('[aria-label="View thread Other"]')).toBeNull();
    expect(container.querySelector('[aria-label="View thread Finished"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="View thread Live"]')!.click());
    expect(container.querySelector('[aria-label="Steer this thread"]')).not.toBeNull();
    expect(container.textContent).toContain('Remote worker');
    expect(context.onSelectSession).not.toHaveBeenCalled();
    act(() => button('Threads').click());
    expect(container.querySelector('[aria-label="View thread Live"]')).not.toBeNull();
  });

  it('discards a delayed old-scope response and does not fetch an inactive panel', async () => {
    let resolveOld!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }));
    await show();
    await show('/other');
    await act(async () => { resolveOld(json({ tasks: [task('Old scope')] })); });
    expect(container.textContent).not.toContain('Old scope');
    expect(container.querySelector('[aria-label="View thread Other"]')).not.toBeNull();
    const count = fetchMock.mock.calls.length;
    await show('/other', false);
    expect(fetchMock.mock.calls.length).toBe(count);
  });

  it('follows the focused workspace project without changing the globally selected project', async () => {
    await show('/other');
    expect(container.textContent).toContain('Focused project');
    expect(container.querySelector('[aria-label="View thread Other"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="View thread Live"]')).toBeNull();
    expect(projectState.activeProject.id).toBe('project');
  });

  it('loads registered membership for a focused repository outside the global project', async () => {
    fetchMock.mockImplementation(async (url: string) => url === '/api/panel/repos'
      ? json({ repos: [{ ...repo, id: 'other-repo', localPath: '/other' }] })
      : json({ tasks: [{ ...task('Other', 'running', '/other'), project: { id: 'focused-project' } }] }));
    await act(async () => root.render(createElement(O8ThreadsPane, { active: true, repoPath: '/other', repos: [repo] })));
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Create thread"]')!.disabled).toBe(false);
    expect(fetchMock.mock.calls.some((call) => call[0] === '/api/panel/repos')).toBe(true);
    expect(projectState.activeProject.id).toBe('project');
  });

  it('asks for inline confirmation before removing a thread', async () => {
    fetchMock.mockResolvedValueOnce(json({ tasks: [task('Waiting', 'blocked')] }));
    await show();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="View thread Waiting"]')!.click());
    expect(container.querySelector('[aria-label="Thread actions"]')).not.toBeNull();
    expect(container.querySelector('[data-o8-task-action-menu]')).toBeNull();
    expect(container.querySelectorAll('[aria-label="Steer this thread"]')).toHaveLength(1);
    act(() => button('Un-queue / remove').click());
    expect(container.querySelectorAll('[aria-label="Steer this thread"]')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter((call) => call[0].includes('/remove'))).toHaveLength(0);
    expect(container.textContent).toContain('Un-queue “Waiting”?');
    act(() => button('Cancel').click());
    expect(fetchMock.mock.calls.filter((call) => call[0].includes('/remove'))).toHaveLength(0);
  });

  it('shows only evidence from the current execution attempt', async () => {
    const running = { ...task('Remote'), execution: { jobId: 'job', attempt: 2 } };
    fetchMock.mockResolvedValueOnce(json({ tasks: [running] })).mockResolvedValueOnce(json({ jobId: 'job', attempt: 1, logs: [{ id: 1, text: 'Previous attempt output' }], files: [] }));
    await show();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View thread Remote"]')!.click());
    expect(container.textContent).toContain('Attempt 2');
    expect(container.textContent).not.toContain('Previous attempt output');
    expect(fetchMock.mock.calls.some((call) => call[0].includes('jobId=job&attempt=2'))).toBe(true);
  });

  it('refreshes same-attempt evidence and pauses reads when the panel is inactive', async () => {
    const running = { ...task('Remote'), execution: { jobId: 'job', attempt: 2 } };
    let evidenceReads = 0;
    fetchMock.mockImplementation(async (url: string) => url.includes('/evidence?')
      ? json({ jobId: 'job', attempt: 2, logs: [{ id: ++evidenceReads, text: `Output ${evidenceReads}` }], files: [] })
      : json({ tasks: [running] }));
    await show();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View thread Remote"]')!.click());
    expect(container.textContent).toContain('Output 1');
    await act(async () => button('Refresh').click());
    expect(container.textContent).toContain('Output 2');
    const reads = fetchMock.mock.calls.length;
    await show('/repo', false);
    expect(fetchMock.mock.calls.length).toBe(reads);
  });

  it('uses a named danger confirmation for permanent pruning', async () => {
    fetchMock.mockResolvedValueOnce(json({ tasks: [task('Finished', 'done')] }));
    await show();
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.startsWith('Resolved'))!.click());
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="View thread Finished"]')!.click());
    act(() => button('Prune permanently').click());
    const confirm = container.querySelector('[aria-label="Confirm thread action"]')!;
    const prune = [...confirm.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === 'Prune permanently')!;
    expect(prune.style.color).toContain('--t-danger');
    expect(fetchMock.mock.calls.filter((call) => call[0].includes('/prune'))).toHaveLength(0);
  });

  it.each([
    ['steer_outcome_unknown', 'unknown'],
    ['outcome_unknown', null],
  ])('preserves the exact message ID for a real %s error envelope', async (code, outcomeHeader) => {
    const label = `Unknown-${code}`;
    fetchMock.mockResolvedValueOnce(json({ tasks: [task(label)] }));
    await show();
    act(() => container.querySelector<HTMLButtonElement>(`[aria-label="View thread ${label}"]`)!.click());
    const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Steer this thread"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Check the result');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    fetchMock.mockImplementation(async () => {
      const response = json({ ok: false, error: { code, message: 'Outcome is unknown. Inspect current state before taking another action.' } }, 409);
      if (outcomeHeader) response.headers.set('x-o8-steer-outcome', outcomeHeader);
      return response;
    });
    await act(async () => button('Send').click());
    expect(container.textContent).toContain('Inspect current state');
    expect(container.textContent).not.toContain('[object Object]');
    expect(field.disabled).toBe(true);
    const first = fetchMock.mock.calls.find((call) => call[0] === '/api/orchestrator/steer-packet')!;
    expect(JSON.parse(sessionStorage.getItem(`o8:pending-thread-steer:packet-${label}`)!)).toEqual({ id: JSON.parse(first[1].body).idempotencyKey, message: 'Check the result' });
    act(() => button('Threads').click());
    act(() => container.querySelector<HTMLButtonElement>(`[aria-label="View thread ${label}"]`)!.click());
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Steer this thread"]')!.disabled).toBe(true);
    await act(async () => button('Check delivery').click());
    const requests = fetchMock.mock.calls.filter((call) => call[0] === '/api/orchestrator/steer-packet');
    expect(requests).toHaveLength(2);
    expect(requests[0][1].body).toBe(requests[1][1].body);
  });

  it('aborts receipt polling on navigation while retaining the pending message', async () => {
    fetchMock.mockResolvedValueOnce(json({ tasks: [task('Sending')] }));
    await show();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="View thread Sending"]')!.click());
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Steer this thread"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Check the result');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    let signal!: AbortSignal;
    fetchMock.mockImplementationOnce(async (_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal!;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    act(() => button('Send').click());
    await act(async () => button('Threads').click());
    expect(signal.aborted).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="View thread Sending"]')!.click());
    expect(button('Check delivery').disabled).toBe(false);
    expect(fetchMock.mock.calls.filter((call) => call[0] === '/api/orchestrator/steer-packet')).toHaveLength(1);
  });

  it('does not let a delayed receipt in a second detail clear a newer message', async () => {
    const shared = task('Two details');
    const responses: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async () => new Promise<Response>((resolve) => responses.push(resolve)));
    await act(async () => root.render(['first', 'second'].map((key) => createElement(ThreadDetail, {
      key, task: shared, active: true, evidenceRevision: 0, onBack: vi.fn(), actions: null,
    }))));
    const fields = () => [...container.querySelectorAll<HTMLTextAreaElement>('[aria-label="Steer this thread"]')];
    const sendButton = (index: number, label: string) => [...fields()[index].parentElement!.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label)!;
    const typeMessage = (message: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(fields()[0], message);
      fields()[0].dispatchEvent(new Event('input', { bubbles: true }));
    });
    typeMessage('First message');
    act(() => sendButton(0, 'Send').click());
    act(() => sendButton(1, 'Check delivery').click());
    await act(async () => responses[0](json({ ok: true, result: { note: 'Accepted' } })));
    typeMessage('New unsettled message');
    act(() => sendButton(0, 'Send').click());
    await act(async () => responses[2](json({ ok: false, error: { code: 'outcome_unknown', message: 'Inspect this message.' } }, 409)));
    await act(async () => responses[1](json({ ok: true, result: { note: 'Accepted' } })));
    const requests = fetchMock.mock.calls.filter((call) => call[0] === '/api/orchestrator/steer-packet');
    expect(requests).toHaveLength(3);
    expect(requests[0][1].body).toBe(requests[1][1].body);
    const newest = JSON.parse(requests[2][1].body);
    expect(newest.idempotencyKey).not.toBe(JSON.parse(requests[0][1].body).idempotencyKey);
    expect(JSON.parse(sessionStorage.getItem('o8:pending-thread-steer:packet-Two%20details')!)).toEqual({ id: newest.idempotencyKey, message: newest.message });
    expect(sendButton(0, 'Check delivery').disabled).toBe(false);
  });

  it('waits for the persisted steer outcome and reuses one message id while pending', async () => {
    await show();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="View thread Live"]')!.click());
    const field = container.querySelector<HTMLTextAreaElement>('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Check the result');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    fetchMock.mockResolvedValueOnce(json({ ok: true, inProgress: true }, 202)).mockResolvedValueOnce(json({ ok: true, result: { note: 'Queued for this worker' } }));
    await act(async () => { button('Send').click(); await new Promise((resolve) => setTimeout(resolve, 850)); });
    const requests = fetchMock.mock.calls.filter((call) => call[0] === '/api/orchestrator/steer-packet');
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0][1].body)).toMatchObject({ packetId: 'packet-Live', message: 'Check the result' });
    expect(requests[0][1].body).toBe(requests[1][1].body);
    expect(container.textContent).toContain('Queued for this worker');
    expect(context.onSelectSession).not.toHaveBeenCalled();
  });
});
