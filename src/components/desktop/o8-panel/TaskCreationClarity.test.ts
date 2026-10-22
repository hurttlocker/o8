// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { O8ThreadsPane } from './O8ThreadsPane';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const project = vi.hoisted(() => ({ id: 'project', name: 'Project', repoPaths: ['/fixture/repo'], createdAt: '' }));
vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => null }));
vi.mock('../repo-registry/useProjects', () => ({ useProjects: () => ({ activeProject: project, ledger: { projects: [project] }, loading: false }) }));
vi.mock('@/lib/tauri/ipc-fetch', () => ({ ipcFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const repo: RepoRegistryEntry = {
  id: 'repo', name: 'Repo', localPath: '/fixture/repo', remoteUrl: null, defaultBranch: 'main', addedAt: '', lastOpenedAt: null, storagePressureParkingDisabled: false,
  setup: { envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false, buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null, workspaceIsolationPreference: 'auto' },
};
const json = (body: unknown, status = 200) => Response.json(body, { status });
let host: HTMLDivElement, root: Root, tasks: TaskPoolTask[], refuseDispatch: boolean;
let requests: Array<{ url: string; body: Record<string, unknown> }>;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)!;
const select = (label: string, value: string) => act(() => {
  const field = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  field.value = value; field.dispatchEvent(new Event('change', { bubbles: true }));
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); tasks = []; requests = []; refuseDispatch = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); requests.push({ url, body });
      if (url === '/api/tasks') {
        tasks.push({
          id: 'fixture-task', packetId: 'fixture-packet', laneId: null, title: body.title, summary: body.summary ?? '', group: 'ready', status: 'ready', repoPath: body.repoPath,
          project: { id: project.id, name: project.name, slug: 'project' }, runtime: body.requestedRuntime, workerIntent: body.workerIntent, workerRouting: null, branch: null, baseBranch: null,
          repoName: repo.name, blockedReason: null, lastEventAt: null, lastEventLabel: null, allowedFiles: [], sourceIssue: null, lane: null,
        });
        return json({ ok: true, taskId: 'fixture-task', note: 'Task saved for later.' });
      }
      return refuseDispatch ? json({ ok: false, error: 'Fixture worker disconnected.' }, 409) : json({ ok: true });
    }
    if (url.includes('worker-availability')) return json({ available: true, connectedWorkers: 1, detail: 'Fixture worker connected.' });
    return json({ tasks, repos: [repo] });
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function open() {
  await act(async () => root.render(createElement(O8ThreadsPane, { active: true, repoPath: repo.localPath, repos: [repo] })));
  expect(button('Create task')).toBeDefined();
  await act(async () => button('Create task').click());
  const title = host.querySelector<HTMLInputElement>('[aria-label="Task title"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Clear task');
    title.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('task creation clarity through Threads', () => {
  it('explains the task/thread relationship and both actions before exposing worker options', async () => {
    await open();
    expect(host.textContent).toContain('Tasks appear as threads with their progress and results.');
    expect(host.textContent).toContain('Save task keeps it ready for later. Start task also requests an agent.');
    const options = host.querySelector<HTMLDetailsElement>('details')!;
    expect(options).not.toBeNull(); expect(options.open).toBe(false);
    expect(options.querySelector('summary')?.textContent).toContain('Heavy worker');
    expect(options.querySelector('summary')?.textContent).toContain('Automatic model');
    expect(options.querySelector('summary')?.textContent).toContain('Adaptive effort');
    expect(options.contains(host.querySelector('[aria-label="Task repository"]'))).toBe(false);
    expect(options.contains(host.querySelector('[aria-label="Task execution location"]'))).toBe(false);
    expect(options.querySelector('[aria-label="Task worker role"]')).not.toBeNull();
    expect(button('Save task')).toBeDefined(); expect(button('Start task')).toBeDefined();
    expect(requests).toEqual([]);
  });

  it('saves an ordinary task into Threads without dispatching or changing hidden defaults', async () => {
    await open(); await act(async () => button('Save task').click());
    expect(requests).toEqual([{ url: '/api/tasks', body: { title: 'Clear task', summary: null, projectId: 'project', repoPath: repo.localPath, workerIntent: 'heavy_worker', requestedRuntime: 'codex', model: null, requestedEffort: null } }]);
    expect(host.querySelector('[aria-label="View thread Clear task"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="New task"]')).toBeNull();
  });

  it('keeps inspected pins when options close, and requests dispatch only for explicit Start task without local fallback', async () => {
    await open();
    const options = host.querySelector<HTMLDetailsElement>('details')!;
    expect(options).not.toBeNull(); options.open = true;
    select('Task execution location', 'cloud'); select('Task worker role', 'reviewer');
    select('Task model', 'gpt-6.1-sol'); select('Task reasoning effort', 'medium');
    options.open = false;
    expect(requests).toEqual([]); expect(options.querySelector('summary')?.textContent).toContain('Reviewer');
    refuseDispatch = true; await act(async () => button('Start task').click());
    expect(requests.map(request => request.url)).toEqual(['/api/tasks', '/api/tasks/fixture-task/dispatch']);
    expect(requests[0].body).toMatchObject({ workerIntent: 'reviewer', requestedRuntime: 'cloud', model: 'gpt-6.1-sol', requestedEffort: 'medium' });
    expect(requests[1].body).toEqual({ actor: 'orchestrator', projectId: 'project', repoPath: repo.localPath });
    expect(host.textContent).toContain('Fixture worker disconnected.');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Task title"]')?.value).toBe('Clear task');
  });
});
