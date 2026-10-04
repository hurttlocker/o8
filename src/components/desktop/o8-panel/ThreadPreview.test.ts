// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadDetail } from './ThreadDetail';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';

vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => null }));
vi.mock('@/lib/tauri/ipc-fetch', () => ({ ipcFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/tauri/remote-preview', () => ({ remotePreviewSupported: async () => true }));
vi.mock('@/components/desktop/NativeRemotePreview', () => ({ NativeRemotePreview: () => null }));

const remoteTask = (attempt = 2, id = 'remote') => ({
  id, packetId: `packet-${id}`, title: 'Completed remote result', summary: 'Recorded brief',
  group: 'review', runtime: 'cloud',
  execution: { kind: 'remote_worker', jobId: 'result-job', attempt, status: 'completed', previewAccess: 'requestable' },
} as TaskPoolTask);

describe('thread detail remote preview entry and ownership', () => {
  let root: Root;
  let container: HTMLDivElement;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return Response.json({ id: 'listener', url: 'http://[::1]:1234/', service: 'web', serviceJobId: 'review-service' });
      if (options?.method === 'DELETE') return Response.json({ ok: true });
      return Response.json({ jobId: 'result-job', attempt: 2, logs: [{ id: 1, text: 'Completed output' }], files: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); sessionStorage.clear(); vi.unstubAllGlobals();
  });
  const render = async (task = remoteTask(), active = true) => {
    await act(async () => root.render(createElement(ThreadDetail, {
      task, active, evidenceRevision: 0, onBack: () => {}, actions: null,
    })));
  };
  const click = async (label: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  };
  const requests = (method: string) => fetchMock.mock.calls.filter((call) => call[1]?.method === method)
    .map(([url, options]) => ({ url, body: JSON.parse(options.body) }));

  it('opens the actual preview from current thread detail and closes it on Back', async () => {
    await render();
    expect(requests('POST')).toHaveLength(0);
    expect(container.textContent).toContain('Completed output');
    await click('Remote preview');
    expect(requests('POST')).toEqual([{ url: '/api/tasks/remote/preview', body: { jobId: 'result-job', attempt: 2 } }]);
    expect(container.textContent).toContain('Remote preview · attempt 2 · web');
    expect(container.querySelector('[aria-label="Steer this thread"]')).not.toBeNull();
    await click('Back');
    expect(requests('DELETE')).toContainEqual({ url: '/api/tasks/remote/preview', body: { id: 'listener', serviceJobId: 'review-service', keepService: false } });
    expect(container.textContent).toContain('Completed output');
  });

  it('stops when inactive and requires an explicit open on return', async () => {
    await render(); await click('Remote preview');
    await render(remoteTask(), false);
    expect(requests('DELETE')).toHaveLength(1);
    await render();
    expect(requests('POST')).toHaveLength(1);
    expect(container.textContent).not.toContain('Remote preview · attempt');
    await click('Remote preview');
    expect(requests('POST')).toHaveLength(2);
  });

  it.each([
    ['attempt', () => remoteTask(3)],
    ['task', () => remoteTask(2, 'another-task')],
  ])('closes the old resource on %s change without automatically allocating another', async (_label, nextTask) => {
    await render(); await click('Remote preview');
    const next = nextTask(); await render(next);
    expect(requests('DELETE')).toContainEqual({ url: '/api/tasks/remote/preview', body: { id: 'listener', serviceJobId: 'review-service', keepService: false } });
    expect(requests('POST')).toHaveLength(1);
    await click('Remote preview');
    expect(requests('POST').at(-1)).toEqual({ url: `/api/tasks/${next.id}/preview`, body: { jobId: next.execution!.jobId, attempt: next.execution!.attempt } });
  });

  it.each(['done', 'unavailable', 'local'])('offers no preview for a %s result', async (state) => {
    const task = remoteTask();
    if (state === 'done') task.group = 'done';
    if (state === 'unavailable') task.execution!.previewAccess = 'unavailable';
    if (state === 'local') task.execution = null;
    await render(task);
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === 'Remote preview')).toBe(false);
    expect(requests('POST')).toHaveLength(0);
  });

  it('cleans a late allocation after the user leaves the panel', async () => {
    let allocated!: (response: Response) => void;
    fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => options?.method === 'POST'
      ? new Promise<Response>((resolve) => { allocated = resolve; }) : Response.json({ ok: true }));
    await render(); await click('Remote preview');
    await render(remoteTask(), false);
    await act(async () => allocated(Response.json({ id: 'late-listener', url: 'http://[::1]:1234/', serviceJobId: 'late-service' })));
    expect(requests('DELETE')).toContainEqual({ url: '/api/tasks/remote/preview', body: { id: 'late-listener', serviceJobId: 'late-service', keepService: false } });
    await render(); expect(requests('POST')).toHaveLength(1);
  });
});
