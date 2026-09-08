// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTimelineData, useTimelineSessions } from './hooks';

vi.mock('@/lib/panel/fetch-cache', () => ({
  fetchOnce: (url: string) => fetch(url),
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;
const TIMELINE = '/api/panel/timeline';
const INBOX = '/api/mobile/inbox?workspaceReview=0';

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('timeline refresh through mounted hooks', () => {
  let host: HTMLDivElement;
  let root: Root | null;
  let revision: number;
  let hold: boolean;
  let pending: Array<() => void>;
  const fetchMock = vi.fn<(url: string) => Promise<Response>>();

  function Harness() {
    const timeline = useTimelineData();
    const sessions = useTimelineSessions();
    return createElement('output', null, JSON.stringify({ timeline, sessions }));
  }

  function calls(url: string) {
    return fetchMock.mock.calls.filter(([calledUrl]) => calledUrl === url).length;
  }

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
    sessionStorage.clear();
    revision = 1;
    hold = false;
    pending = [];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) => {
      const response = {
        ok: true,
        json: async () => url === TIMELINE
          ? { segments: [{ kind: 'coding', startMin: 0, durationMin: revision }],
            windowMinutes: 1440, anchorStartIso: '2026-09-08T00:00:00.000Z' }
          : { sessions: [{ id: `session-${revision}` }] },
      } as Response;
      if (hold) return new Promise<Response>((resolve) => { pending.push(() => resolve(response)); });
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root?.unmount());
    host.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps the delayed first load and visible five-minute fallback', async () => {
    await advance(2999);
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(1);
    expect(calls(TIMELINE)).toBe(1);
    expect(calls(INBOX)).toBe(1);
    expect(JSON.parse(host.textContent ?? '{}').timeline.loading).toBe(false);

    await advance(296999);
    expect(calls(TIMELINE)).toBe(1);
    await advance(1);
    expect(calls(TIMELINE)).toBe(2);
    expect(calls(INBOX)).toBe(2);
  });

  it('defers hidden timers and events, then updates state and storage once on return', async () => {
    await advance(3000);
    act(() => {
      setVisibility('hidden');
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      window.dispatchEvent(new Event('o8:inbox'));
    });
    await advance(600000);
    expect(calls(TIMELINE)).toBe(1);
    expect(calls(INBOX)).toBe(1);

    revision = 2;
    act(() => setVisibility('visible'));
    await advance(0);
    expect(calls(TIMELINE)).toBe(2);
    expect(calls(INBOX)).toBe(2);
    const current = JSON.parse(host.textContent ?? '{}');
    expect(current.timeline.segments[0].durationMin).toBe(2);
    expect(current.sessions[0].id).toBe('session-2');
    expect(JSON.parse(sessionStorage.getItem('cortex-timeline') ?? '{}').segments[0].durationMin).toBe(2);
  });

  it('coalesces visible event bursts and cancels refreshes after unmount', async () => {
    await advance(3000);
    hold = true;
    act(() => window.dispatchEvent(new Event('o8:lifecycle-reconcile')));
    await advance(0);
    expect(calls(TIMELINE)).toBe(2);
    expect(calls(INBOX)).toBe(2);
    act(() => {
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      window.dispatchEvent(new Event('o8:inbox'));
    });
    await advance(0);
    expect(calls(TIMELINE)).toBe(2);
    expect(calls(INBOX)).toBe(2);
    hold = false;
    await act(async () => { pending.splice(0).forEach((resolve) => resolve()); });
    await advance(0);
    expect(calls(TIMELINE)).toBe(3);
    expect(calls(INBOX)).toBe(3);

    act(() => root?.unmount());
    root = null;
    act(() => {
      window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      window.dispatchEvent(new Event('o8:inbox'));
      setVisibility('hidden');
      setVisibility('visible');
    });
    await advance(600000);
    expect(calls(TIMELINE)).toBe(3);
    expect(calls(INBOX)).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the delayed initial load on unmount', async () => {
    act(() => root?.unmount());
    root = null;
    await advance(600000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
