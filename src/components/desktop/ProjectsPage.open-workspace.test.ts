/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectsPage } from './ProjectsPage';
import { dispatchFocusRepoWorkspaceTab } from '@/lib/desktop/events';

vi.mock('@/lib/desktop/events', () => ({ dispatchFocusRepoWorkspaceTab: vi.fn(() => true) }));
const repo = { id: 'repo', name: 'Repo', localPath: '/repo', remoteUrl: null, defaultBranch: 'main' };
const projects = [
  { id: 'first', name: 'First', slug: 'first', repos: [{ repoId: 'repo' }], mainRepoId: 'repo', createdAt: 1, updatedAt: 1 },
  { id: 'empty', name: 'Empty', slug: 'empty', repos: [], mainRepoId: null, createdAt: 1, updatedAt: 1 },
];
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('opens a workspace directly from its row while details browsing keeps the work target intact', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetchMock = vi.fn(async (url: string) => Response.json(url === '/api/projects' ? { projects }
    : url === '/api/panel/repos' ? { repos: [repo] } : {}));
  vi.stubGlobal('fetch', fetchMock);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const onClose = vi.fn();
  const button = (text: string, parent: ParentNode = host) => [...parent.querySelectorAll('button')].find(node => node.textContent === text)!;
  try {
    await act(async () => root.render(createElement(ProjectsPage, { onClose })));
    const details = host.querySelector<HTMLButtonElement>('[aria-label="View details for First"]');
    expect(details).not.toBeNull();
    await act(async () => details!.click());
    expect(dispatchFocusRepoWorkspaceTab).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/panel/projects/active')).toBe(false);
    await act(async () => button('All projects').click());
    const actions = host.querySelector('[role="group"][aria-label="First actions"]')!;
    expect(button('Open workspace', actions).disabled).toBe(false);
    const empty = host.querySelector('[role="group"][aria-label="Empty actions"]')!;
    expect(button('Open workspace', empty).disabled).toBe(true);
    for (let round = 0; round < 3; round++) await act(async () => button('Open workspace', actions).click());
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(dispatchFocusRepoWorkspaceTab).toHaveBeenLastCalledWith({ repoId: 'repo', repoPath: '/repo' });
    const opens = fetchMock.mock.calls.filter(([url]) => url === '/api/panel/projects/active');
    expect(opens).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledWith('/api/panel/projects/active', expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectId: 'first' }) }));
  } finally { act(() => root.unmount()); host.remove(); }
});

it('keeps the row recoverable when opening the selected project fails', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/panel/projects/active'
    ? Response.json({}, { status: 503 }) : Response.json(url === '/api/projects' ? { projects }
      : url === '/api/panel/repos' ? { repos: [repo] } : {})));
  const host = document.createElement('div'); const root = createRoot(host); const onClose = vi.fn();
  try {
    await act(async () => root.render(createElement(ProjectsPage, { onClose })));
    const open = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="First actions"] button')].find(node => node.textContent === 'Open workspace');
    expect(open).toBeDefined();
    await act(async () => open!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not open this project');
    expect(open!.disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(dispatchFocusRepoWorkspaceTab).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); }
});
