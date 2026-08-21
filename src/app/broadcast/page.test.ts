// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MotionProps = {
  children?: ReactNode;
  initial?: unknown;
  animate?: unknown;
  transition?: unknown;
} & Record<string, unknown>;

vi.mock('framer-motion', () => {
  const renderMotionElement = (tag: 'article' | 'span', props: MotionProps) => {
    const domProps = { ...props };
    const children = domProps.children as ReactNode;
    delete domProps.children;
    delete domProps.initial;
    delete domProps.animate;
    delete domProps.transition;
    return createElement(tag, domProps, children);
  };
  return {
    motion: {
      article: (props: MotionProps) => renderMotionElement('article', props),
      span: (props: MotionProps) => renderMotionElement('span', props),
    },
    useReducedMotion: () => false,
  };
});

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
  lanes: [{
    id: 'lane-one',
    packetId: 'packet-one',
    repo: 'o8',
    label: 'Working lane',
    runtime: 'codex',
    status: 'running',
    lastEventAt: '2026-08-21T12:00:00.000Z',
    lastEventLabel: 'Change merged',
  }],
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
  let snapshotPayload = snapshot;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(input).includes('/api/broadcast/snapshot')) {
      return Promise.resolve(Response.json(snapshotPayload));
    }
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort, { once: true });
    });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.sessionStorage.clear();
    window.sessionStorage.setItem('o8.broadcast.spectator-token', 'spectator-test-token');
    window.history.replaceState(null, '', '/broadcast');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_280, writable: true });
    snapshotPayload = snapshot;
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

  it('reads a hash token without waiting for requestAnimationFrame', async () => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/broadcast#token=hash-spectator-token');
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
      throw new Error('token boot must not wait for an animation frame');
    });

    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await Promise.resolve(); });

    expect(animationFrame).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer hash-spectator-token' });
    expect(window.location.hash).toBe('');
    expect(window.sessionStorage.getItem('o8.broadcast.spectator-token')).toBe('hash-spectator-token');
  });

  it('hides the header when compact mode is requested', async () => {
    window.history.replaceState(null, '', '/broadcast?compact=1');
    await act(async () => { root.render(createElement(BroadcastPage)); });

    expect(container.querySelector('header')).toBeNull();
    expect(container.querySelector('[aria-label="Broadcast stage"]')).not.toBeNull();
  });

  it('shows lane-aware dead air after 90 seconds', async () => {
    snapshotPayload = { ...snapshot, recentEvents: [] };
    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-broadcast-dead-air="true"]')).toBeNull();
    expect(container.textContent).toContain('Following 1 lane.');
    expect(container.textContent).not.toContain('Waiting for governed activity');

    await act(async () => { await vi.advanceTimersByTimeAsync(90_001); });

    const deadAir = container.querySelector('[data-broadcast-dead-air="true"]');
    expect(deadAir?.textContent).toContain('watching 1 lane');
    expect(deadAir?.textContent).toContain('Working lane');
    expect(container.textContent).not.toContain('Waiting for governed activity');
  });

  it('uses a 60/40 stage at the 1600px breakpoint and a single column below it', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_600, writable: true });
    await act(async () => { root.render(createElement(BroadcastPage)); });

    const stage = container.querySelector<HTMLElement>('[aria-label="Broadcast stage"]');
    expect(stage?.style.display).toBe('grid');
    expect(stage?.style.gridTemplateColumns).toBe('minmax(0, 3fr) minmax(0, 2fr)');

    window.innerWidth = 1_599;
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    expect(stage?.style.display).toBe('flex');
    expect(stage?.style.flexDirection).toBe('column');
  });
});
