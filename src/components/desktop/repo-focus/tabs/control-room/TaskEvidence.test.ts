// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskActionMenu } from './TaskSection';
import type { TaskPoolTask } from './types';

const task = {
  id: 'packet-a', packetId: 'packet-a', title: 'Remote task', group: 'running', runtime: 'cloud',
  repoName: 'sample', execution: {
    kind: 'remote_worker', jobId: 'job-a', sessionKey: 'cloud:job-a', status: 'leased',
    attempt: 2, workerId: 'worker-b', leaseState: 'active', updatedAt: new Date().toISOString(),
    workspaceAccess: 'unavailable', previewAccess: 'unavailable',
  },
} as TaskPoolTask;

describe('Control Room remote evidence action', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.unstubAllGlobals();
  });

  it('opens the selected packet attempt and renders its bounded receipts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      packetId: 'packet-a', jobId: 'job-a',
      attempt: 2, status: 'leased', leaseState: 'active', logsTruncated: false, filesTruncated: false,
      logs: [{ id: 42, text: 'worker output', createdAt: new Date().toISOString() }],
      files: [{ path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1 }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(createElement(TaskActionMenu, {
      state: { task, x: 30, y: 30 }, busyKey: null, onClose: vi.fn(), onAction: vi.fn(), onRefreshTask: vi.fn(),
    })));
    const open = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Remote logs & files');
    await act(async () => { open?.click(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/packet-a/evidence?jobId=job-a&attempt=2', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
    expect(container.textContent).toContain('worker output');
    expect(container.textContent).toContain('src/app.ts');
    expect(container.textContent).toContain('Remote editor is unavailable.');
    expect(container.textContent).toContain('Preview is unavailable for this attempt.');
  });

  it('uses the latest claim attempt after the task list refreshes', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve(Response.json({
      packetId: 'packet-a', jobId: 'job-a',
      attempt: url.includes('attempt=3') ? 3 : 2,
      status: 'leased', leaseState: 'active', logsTruncated: false, filesTruncated: false,
      logs: [{ id: 43, text: url.includes('attempt=3') ? 'new worker output' : 'old worker output', createdAt: new Date().toISOString() }],
      files: [],
    })));
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const latestTask = { ...task, execution: { ...task.execution!, attempt: 3 } } as TaskPoolTask;
    const onRefreshTask = vi.fn(async () => {
      root?.render(createElement(TaskActionMenu, {
        state: { task: latestTask, x: 30, y: 30 }, busyKey: null, onClose: vi.fn(), onAction: vi.fn(), onRefreshTask,
      }));
    });
    act(() => root?.render(createElement(TaskActionMenu, {
      state: { task, x: 30, y: 30 }, busyKey: null, onClose: vi.fn(), onAction: vi.fn(), onRefreshTask,
    })));
    await act(async () => { [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Remote logs & files')?.click(); });
    await act(async () => { [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Refresh')?.click(); });
    expect(onRefreshTask).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/packet-a/evidence?jobId=job-a&attempt=3', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
    expect(container.textContent).toContain('new worker output');
  });

  it('keeps receipts inside the owning board and viewport when a sidebar is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      packetId: 'packet-a', jobId: 'job-a', attempt: 2,
      status: 'leased', leaseState: 'active', logs: [], files: [],
      logsTruncated: false, filesTruncated: false,
    })));
    container = document.createElement('div');
    document.body.appendChild(container);
    const sidebar = document.createElement('div');
    sidebar.dataset.o8AgentPanel = 'true';
    sidebar.getBoundingClientRect = () => ({ left: 0, right: 250, top: 0, bottom: 1500 } as DOMRect);
    container.appendChild(sidebar);
    const sheet = document.createElement('main');
    sheet.style.overflowX = 'auto';
    sheet.style.overflowY = 'auto';
    sheet.getBoundingClientRect = () => ({ left: 280, right: 1010, top: 4, bottom: 660 } as DOMRect);
    container.appendChild(sheet);
    const board = document.createElement('div');
    board.getBoundingClientRect = () => ({ left: 300, right: 1000, top: -20, bottom: 1500 } as DOMRect);
    sheet.appendChild(board);
    root = createRoot(board);
    act(() => root?.render(createElement(TaskActionMenu, {
      state: { task, x: 980, y: 740 }, boundaryElement: board,
      busyKey: null, onClose: vi.fn(), onAction: vi.fn(), onRefreshTask: vi.fn(),
    })));
    await act(async () => { [...board.querySelectorAll('button')].find((button) => button.textContent === 'Remote logs & files')?.click(); });
    const menu = board.querySelector<HTMLElement>('[data-o8-task-action-menu="true"]')!;
    expect(menu.style.width).toBe('480px');
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(308);
    expect(parseFloat(menu.style.left) + 480).toBeLessThanOrEqual(992);
    expect(parseFloat(menu.style.top) + 480).toBeLessThanOrEqual(652);
    expect(parseFloat(menu.style.maxHeight)).toBe(640);
  });
});
