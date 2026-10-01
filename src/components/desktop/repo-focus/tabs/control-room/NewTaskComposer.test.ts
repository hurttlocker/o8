// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewTaskComposer } from './NewTaskComposer';
import { createTaskRequest } from './create-task-request';

describe('task execution placement', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onCreate = vi.fn();
  const onDispatch = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  async function show(available: boolean) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ available, connectedWorkers: available ? 1 : 0, detail: available ? '1 remote worker connected.' : 'No remote worker connected.' }) })));
    await act(async () => root.render(createElement(NewTaskComposer, {
      repos: [{ id: 'repo', name: 'Repo', localPath: '/tmp/fixture', remoteUrl: null, defaultBranch: 'main' }],
      title: 'Task', summary: '', repoPath: '/tmp/fixture', workerIntent: 'light_worker', busy: false,
      onTitleChange: vi.fn(), onSummaryChange: vi.fn(), onRepoPathChange: vi.fn(), onWorkerIntentChange: vi.fn(),
      onCancel: vi.fn(), onCreate, onCreateAndDispatch: onDispatch,
    })));
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Task execution location"]')!;
    act(() => { select.value = 'cloud'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  }
  function button(label: string) {
    return Array.from(container.querySelectorAll('button')).find((node) => node.textContent === label)!;
  }

  it('allows saving remote placement while refusing dispatch to a disconnected pool', async () => {
    await show(false);
    expect(container.textContent).toContain('No remote worker connected.');
    expect(button('Add + dispatch').disabled).toBe(true);
    act(() => button('Add').click());
    expect(onCreate).toHaveBeenCalledWith('cloud', null);
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('passes remote placement when the operator dispatches to a connected pool', async () => {
    await show(true);
    expect(button('Add + dispatch').disabled).toBe(false);
    const model = container.querySelector<HTMLSelectElement>('select[aria-label="Task model"]')!;
    act(() => { model.value = 'gpt-6-sol'; model.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => button('Add + dispatch').click());
    expect(onDispatch).toHaveBeenCalledWith('cloud', 'gpt-6-sol');
  });

  it('preserves placement across create and dispatch, and surfaces a server refusal without retrying locally', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, taskId: 'task-remote' }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Remote worker disconnected.' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(createTaskRequest({ title: 'Task', summary: null, repoPath: '/tmp/fixture', projectId: 'project', workerIntent: 'light_worker', requestedRuntime: 'cloud', model: 'gpt-6-sol' }, true))
      .rejects.toThrow('Remote worker disconnected.');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ requestedRuntime: 'cloud', model: 'gpt-6-sol' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/tasks/task-remote/dispatch');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
