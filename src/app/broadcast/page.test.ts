// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BroadcastEvent, BroadcastSnapshot } from '@/lib/broadcast/types';
import { getPalette, resolveTheme } from '@/lib/theme/registry';

type MotionProps = {
  children?: ReactNode;
  initial?: unknown;
  animate?: unknown;
  transition?: unknown;
} & Record<string, unknown>;

const motionState = vi.hoisted(() => ({ reduced: false }));

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
    useReducedMotion: () => motionState.reduced,
  };
});

import BroadcastPage from './page';

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}

const snapshot: BroadcastSnapshot = {
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
  focus: null,
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

const OVERLAY_TOKEN = 'o8sp_overlay_spectator_token';

const commentaryEvent: BroadcastEvent = {
  ...snapshot.recentEvents[0],
  id: 'commentary-one',
  kind: 'commentary',
  title: 'Mister',
  detail: 'The ship focus is set to v0.1.700.',
  timestamp: '2026-08-21T11:59:59.000Z',
};

describe('Broadcast spectator page', () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshotPayload: BroadcastSnapshot = snapshot;
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
    window.localStorage.clear();
    window.localStorage.setItem('o8.broadcast.spectator-token', 'spectator-test-token');
    window.history.replaceState(null, '', '/broadcast');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_280, writable: true });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1_080, writable: true });
    motionState.reduced = false;
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
    window.localStorage.clear();
    window.history.replaceState(null, '', '/broadcast#token=hash-spectator-token');
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
      throw new Error('token boot must not wait for an animation frame');
    });

    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await Promise.resolve(); });

    expect(animationFrame).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer hash-spectator-token' });
    // The fragment is the overlay's durable carrier — stripping it made the
    // credential single-use and stranded the card after any store loss (#1828).
    expect(window.location.hash).toBe('#token=hash-spectator-token');
    expect(window.localStorage.getItem('o8.broadcast.spectator-token')).toBe('hash-spectator-token');
  });

  it('still boots from a sessionStorage token written by an older build', async () => {
    window.localStorage.clear();
    window.sessionStorage.setItem('o8.broadcast.spectator-token', 'legacy-session-token');
    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await Promise.resolve(); });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer legacy-session-token' });
  });

  it('boots the real overlay URL from its fragment and renders commentary from the API', async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    snapshotPayload = { ...snapshot, recentEvents: [...snapshot.recentEvents, commentaryEvent] };
    window.history.replaceState(null, '', `/broadcast?compact=1&theme=dark#token=${OVERLAY_TOKEN}`);

    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    // The token reached component state: it is the credential on the real request.
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/broadcast/snapshot');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: `Bearer ${OVERLAY_TOKEN}` });
    // The overlay URL survives its own boot, so the next load can re-bootstrap.
    expect(window.location.hash).toBe(`#token=${OVERLAY_TOKEN}`);
    expect(window.location.search).toBe('?compact=1&theme=dark');
    // Commentary comes from the fetched snapshot, not the empty state.
    const commentary = container.querySelector('[aria-label="Latest commentary or conversation"]');
    expect(commentary?.textContent).toContain('The ship focus is set to v0.1.700.');
    expect(commentary?.textContent).not.toContain('No commentary has been broadcast yet.');
    expect(container.textContent).not.toContain('Open the spectator URL returned by o8 broadcast token mint.');
  });

  it('survives a browser-source recreation that reloads the URL with storage cleared', async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    snapshotPayload = { ...snapshot, recentEvents: [...snapshot.recentEvents, commentaryEvent] };
    window.history.replaceState(null, '', `/broadcast?compact=1&theme=dark#token=${OVERLAY_TOKEN}`);

    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    await act(async () => root.unmount());

    // An OBS browser source is recreated: fresh document, storage gone, and the
    // only thing that survives is the URL the operator configured.
    window.localStorage.clear();
    window.sessionStorage.clear();
    fetchMock.mockClear();
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: `Bearer ${OVERLAY_TOKEN}` });
    expect(container.querySelector('[aria-label="Latest commentary or conversation"]')?.textContent)
      .toContain('The ship focus is set to v0.1.700.');
  });

  it('recovers a tokenless overlay when its fragment URL is re-navigated in place', async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    snapshotPayload = { ...snapshot, recentEvents: [...snapshot.recentEvents, commentaryEvent] };
    window.history.replaceState(null, '', '/broadcast?compact=1&theme=dark');

    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(container.textContent).toContain('Open the spectator URL returned by o8 broadcast token mint.');
    expect(fetchMock).not.toHaveBeenCalled();

    // Re-pasting the overlay URL only changes the fragment, so the browser does a
    // same-document navigation: nothing reloads and no mount effect runs again.
    await act(async () => {
      window.history.replaceState(null, '', `/broadcast?compact=1&theme=dark#token=${OVERLAY_TOKEN}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: `Bearer ${OVERLAY_TOKEN}` });
    expect(container.querySelector('[aria-label="Latest commentary or conversation"]')?.textContent)
      .toContain('The ship focus is set to v0.1.700.');
    expect(container.textContent).not.toContain('Open the spectator URL returned by o8 broadcast token mint.');
  });

  it('hides the header when compact mode is requested', async () => {
    window.history.replaceState(null, '', '/broadcast?compact=1');
    await act(async () => { root.render(createElement(BroadcastPage)); });

    expect(container.querySelector('header')).toBeNull();
    expect(container.querySelector('[aria-label="Broadcast stage"]')).not.toBeNull();
  });

  it('pins focus first, ticks its elapsed timer, and hides it after clear', async () => {
    window.history.replaceState(null, '', '/broadcast?compact=1');
    snapshotPayload = {
      ...snapshot,
      focus: {
        title: 'Broadcast focus card',
        goal: 'Keep spectators oriented.',
        issue: 1842,
        startedAt: '2026-08-21T11:59:55.000Z',
      },
    };
    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    const sidebar = container.querySelector('[aria-label="Broadcast sidebar"]');
    expect(sidebar?.firstElementChild?.getAttribute('aria-label')).toBe('Now building');
    expect(sidebar?.firstElementChild?.textContent).toContain('Broadcast focus card');
    expect(sidebar?.firstElementChild?.textContent).toContain('Keep spectators oriented.');
    expect(sidebar?.firstElementChild?.textContent).toContain('#1842');
    expect(container.querySelector('[aria-label="Focus elapsed time"]')?.textContent).toBe('00:05');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(container.querySelector('[aria-label="Focus elapsed time"]')?.textContent).toBe('00:06');

    snapshotPayload = { ...snapshot, focus: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[aria-label="Now building"]')).toBeNull();
  });

  it('applies explicit dark and light palette tokens from the theme registry', async () => {
    window.history.replaceState(null, '', '/broadcast?theme=dark');
    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await Promise.resolve(); });

    const dark = resolveTheme(getPalette('dark'), 'solid');
    expect(container.querySelector('main')?.getAttribute('data-broadcast-theme')).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--t-bg-gradient'))
      .toBe(dark.cssVars['--t-bg-gradient']);
    expect(document.body.style.background).toBe('var(--t-bg-gradient)');

    const light = resolveTheme(getPalette('light'), 'solid');
    window.history.replaceState(null, '', '/broadcast?theme=light');
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(container.querySelector('main')?.getAttribute('data-broadcast-theme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--t-bg-gradient'))
      .toBe(light.cssVars['--t-bg-gradient']);
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

  it('breathes while events arrive, then leaves the LIVE indicator dim and still when idle', async () => {
    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    const indicator = container.querySelector<HTMLElement>('[data-broadcast-feed-state]');
    expect(indicator?.dataset.broadcastFeedState).toBe('active');
    expect(indicator?.style.background).toBe('var(--t-accent-soft-strong)');
    expect(indicator?.style.boxShadow).toContain('var(--t-accent-ring)');

    await act(async () => { await vi.advanceTimersByTimeAsync(90_001); });
    expect(indicator?.dataset.broadcastFeedState).toBe('idle');
    expect(indicator?.style.background).toBe('var(--t-input-bg)');
    expect(indicator?.style.boxShadow).toBe('none');
  });

  it('groups consecutive event kinds and preserves room for verdicts', async () => {
    const approval = { ...snapshot.recentEvents[0], kind: 'approval' as const, title: 'Approval requested' };
    snapshotPayload = {
      ...snapshot,
      recentEvents: [
        { ...approval, id: 'approval-one', timestamp: '2026-08-21T11:59:54.000Z' },
        { ...approval, id: 'approval-two', timestamp: '2026-08-21T11:59:55.000Z' },
        { ...approval, id: 'verdict', kind: 'review_verdict', title: 'Review passed', timestamp: '2026-08-21T11:59:56.000Z' },
        { ...approval, id: 'progress-one', kind: 'progress', title: 'Working', timestamp: '2026-08-21T11:59:57.000Z' },
        { ...approval, id: 'progress-two', kind: 'progress', title: 'Still working', timestamp: '2026-08-21T11:59:58.000Z' },
      ],
    };
    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    const groups = [...container.querySelectorAll<HTMLElement>('[data-broadcast-event-group]')];
    expect(groups.map((group) => [group.dataset.broadcastEventGroup, group.dataset.eventCount])).toEqual([
      ['progress', '2'],
      ['review_verdict', '1'],
      ['approval', '2'],
    ]);
    expect(groups[0].style.paddingTop).toBe('10px');
    expect(groups[1].style.paddingTop).toBe('18px');
    expect(groups[2].textContent).toContain('APPROVAL × 2');
  });

  it('renders approval titles, packet targets, and visibly stale ages from the snapshot', async () => {
    snapshotPayload = {
      ...snapshot,
      pendingApprovals: {
        count: 2,
        items: [
          { id: 'approval-fresh', laneId: 'lane-one', packetId: 'packet-fresh', title: 'Review the visual patch', risk: 'medium', createdAt: '2026-08-21T11:55:00.000Z' },
          { id: 'approval-stale', laneId: 'lane-two', packetId: 'packet-stale', title: 'Approve the merge', risk: 'high', createdAt: '2026-08-21T11:30:00.000Z' },
        ],
      },
    };
    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    const approvals = [...container.querySelectorAll<HTMLElement>('[data-broadcast-approval="true"]')];
    expect(approvals).toHaveLength(2);
    expect(approvals[0].textContent).toContain('Review the visual patch');
    expect(approvals[0].textContent).toContain('packet-fresh · medium');
    expect(approvals[0].querySelector('time')?.textContent).toBe('5m');
    expect(approvals[0].dataset.broadcastAge).toBe('fresh');
    expect(approvals[1].textContent).toContain('Approve the merge');
    expect(approvals[1].querySelector('time')?.textContent).toBe('30m');
    expect(approvals[1].dataset.broadcastAge).toBe('stale');
    expect(approvals[1].style.background).toBe('var(--t-warning-soft)');
  });

  it('keeps active-item contrast but disables shimmer under reduced motion', async () => {
    motionState.reduced = true;
    await act(async () => { root.render(createElement(BroadcastPage)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    const activeLane = container.querySelector<HTMLElement>('[data-broadcast-on-air="active"]');
    expect(activeLane?.style.background).toBe('var(--t-accent-soft)');
    expect(activeLane?.querySelector<HTMLElement>('div > div')?.style.animation).toBe('');
    expect(container.querySelector('[data-broadcast-feed-state]')?.getAttribute('data-broadcast-feed-state')).toBe('active');
  });

  it('uses a 60/40 stage at the 1600px breakpoint and a single column below it', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_600, writable: true });
    await act(async () => { root.render(createElement(BroadcastPage)); });

    const stage = container.querySelector<HTMLElement>('[aria-label="Broadcast stage"]');
    expect(stage?.style.display).toBe('grid');
    expect(stage?.style.gridTemplateColumns).toBe('minmax(0, 3fr) minmax(0, 2fr)');
    expect(stage?.style.height).toBe('calc(100dvh - 140px)');
    expect(stage?.style.overflow).toBe('hidden');
    expect(container.querySelector<HTMLElement>('[aria-label="Broadcast sidebar"]')?.style.display).toBe('grid');
    expect(container.querySelector<HTMLElement>('[aria-label="Broadcast event feed"]')?.style.height).toBe('100%');

    window.innerWidth = 1_599;
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    expect(stage?.style.display).toBe('flex');
    expect(stage?.style.flexDirection).toBe('column');
    expect(stage?.style.height).toBe('');
  });
});
