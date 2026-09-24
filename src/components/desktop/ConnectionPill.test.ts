// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeEventEnvelope } from '@/lib/realtime/types';

const realtime = vi.hoisted(() => ({
  onEvent: null as null | ((event: RealtimeEventEnvelope) => void),
}));

vi.mock('./hooks/DesktopWebSocketContext', () => ({
  useWsConnectionState: () => 'connected',
  useSharedDesktopWs: (_options: unknown, handlers: { onRealtimeEvent: (event: RealtimeEventEnvelope) => void }) => {
    realtime.onEvent = handlers.onRealtimeEvent;
  },
}));

import { ConnectionPill } from './ConnectionPill';

function bridgeEvent(runtime: string, status: 'failed' | 'completed'): RealtimeEventEnvelope {
  return {
    channel: 'mutation',
    event: 'mutation.record',
    data: { mutation: { action: 'realtime-bridge-connection', runtime, status } },
  } as RealtimeEventEnvelope;
}

describe('ConnectionPill bridge status', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    realtime.onEvent = null;
    vi.useRealTimers();
  });

  it('stays visible until every failed bridge channel has recovered', async () => {
    await act(async () => root.render(createElement(ConnectionPill)));
    act(() => {
      realtime.onEvent?.(bridgeEvent('global-snapshot', 'failed'));
      realtime.onEvent?.(bridgeEvent('mobile-inbox', 'failed'));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toContain('Updates reconnecting');

    act(() => {
      realtime.onEvent?.(bridgeEvent('mobile-inbox', 'completed'));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toContain('Updates reconnecting');

    act(() => {
      realtime.onEvent?.(bridgeEvent('global-snapshot', 'completed'));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toBe('');
  });
});
