// @vitest-environment jsdom

import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { transcriptStore } from '@/lib/transcripts/store';
import { useTranscript } from '@/lib/transcripts/useTranscript';
import { buildTranscriptWsCallbacks } from '@/lib/transcripts/wireWsBridge';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  DesktopWebSocketProvider,
  useSharedDesktopWs,
} from './DesktopWebSocketContext';

vi.mock('@/lib/panel/ws-port-client', () => ({
  getBrowserWsPort: () => 47125,
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  disconnect() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

const transcriptCallbacks = buildTranscriptWsCallbacks();

function TranscriptBridgeHost() {
  useSharedDesktopWs(undefined, transcriptCallbacks);
  return null;
}

function TranscriptObserver({ sessionKey }: { sessionKey: string }) {
  useTranscript(sessionKey);
  return null;
}

function LegacySessionHost({ sessionKey }: { sessionKey: string }) {
  useSharedDesktopWs(sessionKey, {});
  return null;
}

function TestTree({
  observers,
  legacySessionKey,
}: {
  observers: string[];
  legacySessionKey?: string;
}) {
  return createElement(
    DesktopWebSocketProvider,
    null,
    createElement(
      Fragment,
      null,
      createElement(TranscriptBridgeHost, { key: 'bridge' }),
      legacySessionKey
        ? createElement(LegacySessionHost, { key: 'legacy', sessionKey: legacySessionKey })
        : null,
      ...observers.map((observer) => createElement(TranscriptObserver, {
        key: observer,
        sessionKey: observer.split(':')[0]!,
      })),
    ),
  );
}

function realtimeSubscribeFrames(socket: FakeWebSocket) {
  return socket.sent.filter((message) => message.type === 'realtime-subscribe') as Array<{
    type: 'realtime-subscribe';
    subscriptions: Array<{ stream: string; since?: number }>;
  }>;
}

function historyFrame(
  sessionKey: string,
  seq: number,
  entries: MobileTranscriptEntry[],
  replace = false,
  capturedSeq?: number,
) {
  return {
    channel: 'realtime',
    event: 'batch',
    data: {
      events: [{
        protocol: 1,
        seq,
        stream: `session:${sessionKey}`,
        channel: 'history',
        event: 'history.snapshot',
        ts: new Date().toISOString(),
        capturedSeq,
        data: { sessionKey, entries, replace },
      }],
    },
  };
}

let host: HTMLDivElement;
let root: Root;

describe('DesktopWebSocketProvider transcript delivery', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'ws-token');
    meta.setAttribute('content', 'local-token');
    document.head.appendChild(meta);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    transcriptStore.clear('worker-a');
    transcriptStore.clear('worker-b');
    host.remove();
    document.head.querySelectorAll('meta').forEach((meta) => meta.remove());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fans realtime history frames into the transcript store without replay duplicates', () => {
    act(() => {
      root.render(createElement(TestTree, { observers: ['worker-a:primary'] }));
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const first: MobileTranscriptEntry = { id: 'entry-1', role: 'assistant', text: 'First answer', timestamp: 10 };
    act(() => socket.message(historyFrame('worker-a', 1, [first])));
    act(() => socket.message(historyFrame('worker-a', 1, [{
      id: 'stale-entry',
      role: 'assistant',
      text: 'Stale replay',
      timestamp: 5,
    }])));

    expect(transcriptStore.getSlice('worker-a').messages).toEqual([first]);

    const second: MobileTranscriptEntry = { id: 'entry-2', role: 'assistant', text: 'Second answer', timestamp: 20 };
    act(() => socket.message(historyFrame('worker-a', 2, [first, second], true)));

    expect(transcriptStore.getSlice('worker-a').messages).toEqual([first, second]);

    const third: MobileTranscriptEntry = { id: 'entry-3', role: 'assistant', text: 'Live update', timestamp: 30 };
    act(() => socket.message(historyFrame('worker-a', 4, [third])));
    act(() => socket.message(historyFrame('worker-a', 5, [first], true, 2)));
    expect(transcriptStore.getSlice('worker-a').messages).toEqual([first, second, third]);

    const legacy: MobileTranscriptEntry = { id: 'entry-4', role: 'assistant', text: 'Legacy update', timestamp: 40 };
    act(() => socket.message({
      channel: 'history',
      event: 'update',
      data: { sessionKey: 'worker-a', entries: [legacy] },
    }));
    expect(transcriptStore.getSlice('worker-a').messages).toEqual([first, second, third, legacy]);

    act(() => socket.message(historyFrame('worker-a', 6, [], true)));
    expect(transcriptStore.getSlice('worker-a')).toMatchObject({
      messages: [],
      status: 'fresh',
    });

    transcriptStore.setSlice('worker-a', {
      messages: [first],
      status: 'fresh',
      lastUpdated: 1,
    });
    act(() => socket.message({
      channel: 'history',
      event: 'update',
      data: { sessionKey: 'worker-a', entries: [], replace: true },
    }));
    expect(transcriptStore.getSlice('worker-a').messages).toEqual([]);

    transcriptStore.setSlice('worker-a', {
      messages: [first],
      status: 'fresh',
      lastUpdated: 2,
    });
    act(() => socket.message({
      channel: 'history',
      event: 'update',
      data: { sessionKey: 'worker-a', entries: [], replace: false },
    }));
    expect(transcriptStore.getSlice('worker-a').messages).toEqual([first]);
  });

  it('keeps more than forty bootstrap entries visible when incremental polls arrive', () => {
    act(() => {
      root.render(createElement(TestTree, { observers: ['worker-a:primary'] }));
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const retained = Array.from({ length: 75 }, (_, index) => ({
      id: `entry-${index}`,
      role: 'assistant' as const,
      text: `Answer ${index}`,
      timestamp: index + 1,
    }));
    act(() => socket.message(historyFrame('worker-a', 1, retained, true)));
    act(() => socket.message(historyFrame('worker-a', 2, [{
      id: 'entry-75',
      role: 'assistant',
      text: 'Answer 75',
      timestamp: 76,
    }], false)));

    const visible = transcriptStore.getSlice('worker-a').messages;
    expect(visible).toHaveLength(76);
    expect(visible[0]?.id).toBe('entry-0');
    expect(visible.at(-1)?.id).toBe('entry-75');
  });

  it('keeps runtime, steer, and huddle entries through reconnect replacement and live deltas', () => {
    act(() => {
      root.render(createElement(TestTree, { observers: ['worker-a:primary'] }));
    });
    const firstSocket = FakeWebSocket.instances[0]!;
    act(() => firstSocket.open());

    const runtimeEntry: MobileTranscriptEntry = {
      id: 'runtime-1',
      role: 'assistant',
      text: 'Runtime answer',
      timestamp: 10,
    };
    const steerEntry: MobileTranscriptEntry = {
      id: 'steer-1',
      role: 'user',
      text: 'Operator direction',
      timestamp: 20,
    };
    const huddleEntry: MobileTranscriptEntry = {
      id: 'huddle-1',
      role: 'assistant',
      text: 'Huddle plan',
      timestamp: 30,
    };
    act(() => firstSocket.message(historyFrame(
      'worker-a',
      1,
      [runtimeEntry, steerEntry, huddleEntry],
      true,
    )));
    expect(transcriptStore.getSlice('worker-a').messages.map((entry) => entry.id)).toEqual([
      'runtime-1',
      'steer-1',
      'huddle-1',
    ]);

    act(() => firstSocket.disconnect());
    act(() => vi.advanceTimersByTime(1_000));
    const reconnectedSocket = FakeWebSocket.instances[1]!;
    act(() => reconnectedSocket.open());
    const reconnectHuddle: MobileTranscriptEntry = {
      id: 'huddle-2',
      role: 'assistant',
      text: 'Reconnect huddle plan',
      timestamp: 40,
    };
    act(() => reconnectedSocket.message(historyFrame(
      'worker-a',
      2,
      [runtimeEntry, steerEntry, huddleEntry, reconnectHuddle],
      true,
    )));

    const runtimeDelta: MobileTranscriptEntry = {
      id: 'runtime-2',
      role: 'assistant',
      text: 'Runtime answer after reconnect',
      timestamp: 50,
    };
    act(() => reconnectedSocket.message(historyFrame('worker-a', 3, [runtimeDelta])));
    const visibleIds = transcriptStore.getSlice('worker-a').messages.map((entry) => entry.id);
    expect(visibleIds).toEqual([
      'runtime-1',
      'steer-1',
      'huddle-1',
      'huddle-2',
      'runtime-2',
    ]);
    expect(new Set(visibleIds).size).toBe(visibleIds.length);
  });

  it('coalesces mounted session refs and requests one bootstrap set after reconnect', () => {
    act(() => {
      root.render(createElement(TestTree, {
        observers: ['worker-a:primary', 'worker-a:duplicate', 'worker-b:primary'],
      }));
    });
    const firstSocket = FakeWebSocket.instances[0]!;
    act(() => firstSocket.open());

    const initialSubscribe = realtimeSubscribeFrames(firstSocket).at(-1)!;
    expect(initialSubscribe.subscriptions.map((subscription) => subscription.stream)).toEqual([
      'global',
      'session:worker-a',
      'session:worker-b',
    ]);
    expect(vi.getTimerCount()).toBe(1);

    const frameCount = realtimeSubscribeFrames(firstSocket).length;
    act(() => {
      root.render(createElement(TestTree, {
        observers: ['worker-a:primary', 'worker-b:primary'],
      }));
    });
    expect(realtimeSubscribeFrames(firstSocket)).toHaveLength(frameCount);

    act(() => firstSocket.message(historyFrame('worker-b', 9, [{
      id: 'entry-b',
      role: 'assistant',
      text: 'B answer',
      timestamp: 30,
    }])));
    act(() => {
      root.render(createElement(TestTree, { observers: ['worker-b:primary'] }));
    });
    act(() => vi.advanceTimersByTime(0));
    expect(realtimeSubscribeFrames(firstSocket).at(-1)?.subscriptions.map((subscription) => subscription.stream)).toEqual([
      'global',
      'session:worker-b',
    ]);

    act(() => firstSocket.disconnect());
    act(() => vi.advanceTimersByTime(1_000));
    const reconnectedSocket = FakeWebSocket.instances[1]!;
    act(() => reconnectedSocket.open());

    const reconnectSubscribe = realtimeSubscribeFrames(reconnectedSocket).at(-1)!;
    expect(reconnectSubscribe.subscriptions).toEqual([
      { stream: 'global' },
      { stream: 'session:worker-b' },
    ]);
  });

  it('keeps the focused legacy session while batching eight transcript streams', () => {
    act(() => {
      root.render(createElement(TestTree, {
        legacySessionKey: 'focused-chat',
        observers: [],
      }));
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    act(() => {
      root.render(createElement(TestTree, {
        legacySessionKey: 'focused-chat',
        observers: Array.from({ length: 8 }, (_, index) => `worker-${index}:primary`),
      }));
    });
    expect(realtimeSubscribeFrames(socket)).toHaveLength(1);
    act(() => vi.advanceTimersByTime(0));

    const legacyFrames = socket.sent.filter((message) => (
      message.type === 'subscribe' || message.type === 'switch-session'
    ));
    expect(legacyFrames).toEqual([{ type: 'subscribe', sessionKey: 'focused-chat' }]);

    const subscribeFrames = realtimeSubscribeFrames(socket);
    expect(subscribeFrames).toHaveLength(2);
    expect(subscribeFrames.at(-1)?.subscriptions.map((subscription) => subscription.stream)).toEqual([
      'global',
      'session:focused-chat',
      ...Array.from({ length: 8 }, (_, index) => `session:worker-${index}`),
    ]);
    const bootstrapCounts = new Map<string, number>();
    for (const frame of subscribeFrames) {
      for (const subscription of frame.subscriptions) {
        if (subscription.since !== undefined) continue;
        bootstrapCounts.set(subscription.stream, (bootstrapCounts.get(subscription.stream) ?? 0) + 1);
      }
    }
    expect([...bootstrapCounts.values()]).toEqual(Array.from({ length: 10 }, () => 1));
  });

  it('accepts low sequence snapshots after the server boot epoch changes', () => {
    act(() => {
      root.render(createElement(TestTree, { observers: ['worker-a:primary'] }));
    });
    const firstSocket = FakeWebSocket.instances[0]!;
    act(() => firstSocket.open());
    act(() => firstSocket.message({
      channel: 'system',
      event: 'connected',
      data: { bootId: 'boot-a' },
    }));
    act(() => firstSocket.message(historyFrame('worker-a', 50, [{
      id: 'old-epoch',
      role: 'assistant',
      text: 'Old epoch answer',
    }], true)));

    act(() => firstSocket.disconnect());
    act(() => vi.advanceTimersByTime(1_000));
    const restartedSocket = FakeWebSocket.instances[1]!;
    act(() => restartedSocket.open());
    act(() => restartedSocket.message({
      channel: 'system',
      event: 'connected',
      data: { bootId: 'boot-b' },
    }));
    act(() => restartedSocket.message(historyFrame('worker-a', 1, [{
      id: 'new-epoch',
      role: 'assistant',
      text: 'New epoch answer',
    }], true)));

    expect(transcriptStore.getSlice('worker-a').messages).toEqual([
      expect.objectContaining({ id: 'new-epoch' }),
    ]);
  });
});
