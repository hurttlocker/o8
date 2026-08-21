// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/theme/context', () => ({
  ThemeProvider: ({ children }: { children?: ReactNode }) => children,
}));

import BroadcastPage from './page';

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}

const snapshot = {
  schema: 'o8/broadcast.snapshot/v1',
  generatedAt: '2026-08-21T12:00:00.000Z',
  lanes: [],
  packets: [],
  activeAgents: [{
    laneId: 'lane-one',
    packetId: 'packet-one',
    label: 'Working agent',
    repo: 'o8',
    runtime: 'codex',
    status: 'running',
    startedAt: '2026-08-21T12:00:00.000Z',
  }],
  pendingApprovals: { count: 0, items: [] },
  recentEvents: [{
    schema: 'o8/broadcast.event/v1',
    id: 'lane:event-one',
    source: 'lane',
    kind: 'merge',
    laneId: 'lane-one',
    packetId: 'packet-one',
    repo: 'o8',
    actor: 'orchestrator',
    title: 'Change merged',
    detail: null,
    payload: {},
    timestamp: '2026-08-21T12:00:00.000Z',
  }],
  cursor: 'cursor-one',
};

describe('Broadcast spectator page', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(input).includes('/api/broadcast/snapshot')) {
      return Promise.resolve(Response.json(snapshot));
    }
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort, { once: true });
    });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.sessionStorage.clear();
    window.sessionStorage.setItem('o8.broadcast.spectator-token', 'spectator-test-token');
    setVisibility('visible');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    fetchMock.mockClear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses one theme dot color and pauses every poll while the document is hidden', async () => {
    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    await act(async () => { await Promise.resolve(); });

    const dots = [...container.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')];
    expect(dots.length).toBeGreaterThanOrEqual(3);
    expect(new Set(dots.map((dot) => dot.style.border))).toEqual(new Set(['1px solid var(--t-accent)']));
    expect(new Set(dots.map((dot) => dot.style.background))).toEqual(new Set(['var(--t-accent)', 'transparent']));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/snapshot'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/events'))).toHaveLength(1);

    await act(async () => {
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(20);
    });
    // A hidden page paints the latest snapshot once, then stays quiet: no
    // long-poll, no refresh interval.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/snapshot'))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/events'))).toHaveLength(1);
    const hiddenCallCount = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(hiddenCallCount);

    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/snapshot'))).toHaveLength(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/events'))).toHaveLength(2);
  });

  it('paints the first snapshot even when it loads hidden, without polling', async () => {
    setVisibility('hidden');
    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/snapshot'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/events'))).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/events'))).toHaveLength(0);
  });
});
