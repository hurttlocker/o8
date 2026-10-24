// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopWebSocketProvider, useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { buildTranscriptWsCallbacks } from '@/lib/transcripts/wireWsBridge';
import { useTranscript } from '@/lib/transcripts/useTranscript';
import { transcriptStore } from '@/lib/transcripts/store';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { mergeTranscriptEntries } from '@/components/desktop/workspace-terminal/utils';
import { webTree } from '../scripts/next/web-tree';
import stream from '../native/o8-next/fixtures/stream.replay.json';
import streamTree from '../native/o8-next/fixtures/stream.tree.json';
import edges from '../native/o8-next/fixtures/stream-edges.replay.json';
import mergeCases from '../native/o8-next/fixtures/merge-cases.json';
import edgesTree from '../native/o8-next/fixtures/stream-edges.tree.json';

vi.mock('@/lib/panel/ws-port-client', () => ({ getBrowserWsPort: () => 32123 }));
class Socket {
  static OPEN = 1; static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void; onclose?: () => void; onmessage?: (event: MessageEvent) => void;
  sent: Array<{ type: string; subscriptions?: Array<{ stream: string; since?: number }> }> = [];
  constructor() { Socket.instances.push(this); }
  send(bytes: string) { this.sent.push(JSON.parse(bytes)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; }
  disconnect() { this.close(); this.onclose?.(); }
  frame(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
}
const callbacks = buildTranscriptWsCallbacks({ merge: mergeTranscriptEntries });
function Bridge({ sessionKey }: { sessionKey: string }) {
  useSharedDesktopWs(undefined, callbacks);
  useTranscript(sessionKey);
  return null;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

for (const [name, replay, expected] of [['stream', stream, streamTree], ['stream-edges', edges, edgesTree]] as const) {
  it(`${name}: actual web socket provider and transcript bridge reach the native replay oracle`, () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers(); Socket.instances = []; vi.stubGlobal('WebSocket', Socket);
    const key = replay.initial.sessionKey;
    transcriptStore.setSlice(key, { messages: replay.initial.transcript as MobileTranscriptEntry[], status: 'fresh', lastUpdated: 0 });
    const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
    try {
      act(() => root.render(createElement(DesktopWebSocketProvider, null, createElement(Bridge, { sessionKey: key }))));
      let socket = Socket.instances[0]; act(() => socket.open());
      for (const [index, frame] of replay.frames.entries()) {
        if ('disconnectBefore' in replay && index === replay.disconnectBefore) {
          act(() => socket.disconnect()); act(() => vi.advanceTimersByTime(1000));
          socket = Socket.instances.at(-1)!; act(() => socket.open());
        }
        act(() => socket.frame(frame));
      }
      const entries = transcriptStore.getSlice(key).messages;
      expect(webTree(entries)).toEqual(expected);
      expect(JSON.stringify(entries)).not.toContain('MUST NOT APPEAR');
      for (const connection of Socket.instances) {
        expect(connection.sent.some(frame => frame.type === 'realtime-subscribe' && frame.subscriptions?.some(s => s.stream === `session:${key}` && s.since === undefined))).toBe(true);
      }
      if (name === 'stream') expect(Socket.instances).toHaveLength(2);
    } finally {
      act(() => root.unmount()); host.remove(); transcriptStore.clear(key); transcriptStore.clear('llm-chat:other');
    }
  });
}

it('records the dashboard merger, including partial windows and optimistic metadata', () => {
  for (const item of mergeCases) {
    expect(mergeTranscriptEntries(item.current as MobileTranscriptEntry[], item.incoming as MobileTranscriptEntry[]), item.name).toEqual(item.expected);
  }
});
