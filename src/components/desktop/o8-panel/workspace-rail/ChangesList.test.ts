// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceChanges, type WorkspaceChangesState } from './ChangesList';

const FALLBACK_MS = 300_000;

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('mounted workspace changes lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let repoPath: string;
  let sequence = 0;
  let state: WorkspaceChangesState;
  const fetchMock = vi.fn();

  function Consumer({ active = true }: { active?: boolean }) {
    const changes = useWorkspaceChanges(repoPath, { active });
    useEffect(() => { state = changes; }, [changes]);
    return createElement('span', null, changes.branch);
  }

  async function mount(count = 1, active = true) {
    await act(async () => {
      root.render(createElement('div', null,
        ...Array.from({ length: count }, (_, key) => createElement(Consumer, { key, active })),
      ));
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setVisibility('visible');
    repoPath = `/workspace/refresh-test-${++sequence}`;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock.mockReset().mockImplementation(async () => Response.json({ changedFiles: [], branch: 'main' }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('defers a hidden mount and catches up once on return', async () => {
    setVisibility('hidden');
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      await vi.advanceTimersByTimeAsync(FALLBACK_MS * 3);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => { setVisibility('visible'); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/review/workspace?workspace=${encodeURIComponent(repoPath)}&changesOnly=1`,
    );
    expect(container.textContent).toBe('main');
    await act(async () => { setVisibility('visible'); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pauses periodic and lifecycle refreshes while hidden without losing catch-up', async () => {
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      setVisibility('hidden');
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      await vi.advanceTimersByTimeAsync(FALLBACK_MS * 2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { setVisibility('visible'); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(FALLBACK_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('checks visibility again before queued work starts', async () => {
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      setVisibility('hidden');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { setVisibility('visible'); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares requests and keeps the lifecycle until the last consumer leaves', async () => {
    await mount(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await mount(1);
    await act(async () => { window.dispatchEvent(new Event('o8:lifecycle-reconcile')); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      root.render(null);
    });
    // Flush the unmount before scheduling another refresh.
    const before = fetchMock.mock.calls.length;
    await act(async () => {
      setVisibility('hidden');
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(FALLBACK_MS * 2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps explicit refresh available while hidden', async () => {
    setVisibility('hidden');
    await mount();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { await state.refresh(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('main');
  });

  it('cancels queued refreshes when the final consumer unmounts synchronously', async () => {
    await mount();
    act(() => {
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => { await vi.advanceTimersByTimeAsync(FALLBACK_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces in-flight triggers and defers their trailing refresh when hidden', async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      setVisibility('hidden');
      resolveFetch(Response.json({ changedFiles: [], branch: 'main' }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { setVisibility('visible'); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not refresh inactive consumers or leave hidden work after unmount', async () => {
    await mount(1, false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    setVisibility('hidden');
    await mount();
    await mount(1, false);
    await act(async () => {
      setVisibility('visible');
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      await vi.advanceTimersByTimeAsync(FALLBACK_MS);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
