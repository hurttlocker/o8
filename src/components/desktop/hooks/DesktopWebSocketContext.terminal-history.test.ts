// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { buildTerminalTabHandle, type ImperativeHandleDeps } from '../workspace-terminal/terminal-imperative-handle';
import { DesktopWebSocketProvider, useSharedDesktopWs } from './DesktopWebSocketContext';
import { useDesktopWebSocket } from './useDesktopWebSocket';

vi.mock('@/lib/panel/ws-port-client', () => ({ getBrowserWsPort: () => 47125 }));
class Socket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 3;
  static instances: Socket[] = []; readyState = 0;
  onopen: (() => void) | null = null; onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send() {} close() { this.readyState = 3; }
  message(historical?: boolean, port = 61234, redraw = false) {
    const text = `${redraw ? '\x1b[?25l\x1b[H' : ''}Ready at http://localhost:${port}`;
    this.onmessage?.({ data: JSON.stringify({ channel: 'terminal', event: 'data', data: { sessionName: 'terminal-owned', data: btoa(text), ...(historical ? { historical } : {}) } }) } as MessageEvent);
  }
}

it.each(['shared', 'standalone'] as const)('%s exit transport preserves known codes and leaves missing or invalid status unknown', async transport => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('WebSocket', Socket); Socket.instances = [];
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const onTerminalExited = vi.fn();
  const useConnection = transport === 'shared' ? useSharedDesktopWs : useDesktopWebSocket;
  function Consumer() { useConnection(undefined, { onTerminalExited }); return null; }
  try {
    await act(async () => root.render(transport === 'shared' ? createElement(DesktopWebSocketProvider, null, createElement(Consumer)) : createElement(Consumer)));
    const socket = Socket.instances.at(-1)!;
    for (const [raw, source, expected] of [[0, 'process', 0], [17, 'process', 17], [undefined, 'process', null], ['invalid', 'process', null], [1.5, 'process', null], [0, undefined, null], [7, 'transport', null]] as const) {
      await act(async () => socket.onmessage?.({ data: JSON.stringify({ channel: 'terminal', event: 'exited', data: { sessionName: 'ended-owned', exitCode: raw, exitCodeSource: source } }) } as MessageEvent));
      expect(onTerminalExited).toHaveBeenLastCalledWith('ended-owned', expected);
    }
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it.each(['shared', 'standalone'] as const)('%s transport renders retained output without treating replay as a new preview', async transport => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('WebSocket', Socket); Socket.instances = [];
  const meta = document.createElement('meta'); meta.name = 'ws-token'; meta.content = 'test-local-token'; document.head.append(meta);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const write = vi.fn(), detected = vi.fn();
  window.localStorage.clear();
  const makeHandle = (stateScope = `preview-replay-${transport}`) => buildTerminalTabHandle({
    stateScope,
    tabsRef: { current: [{ id: 'terminal-tab', kind: 'terminal', tmuxSession: 'terminal-owned' }] },
    panelRefs: { current: new Map([['terminal-owned', { writeData: write }]]) },
    detectedPortsRef: { current: new Set() }, urlDetectionEnabledRef: { current: true },
    recordTerminalActivity: vi.fn(), onPreviewDetected: detected, setPreviews: vi.fn(),
  } as unknown as ImperativeHandleDeps);
  let handle = makeHandle();
  const callbacks = { onTerminalData: (...args: Parameters<typeof handle.writeToTerminal>) => handle.writeToTerminal(...args) };
  const useConnection = transport === 'shared' ? useSharedDesktopWs : useDesktopWebSocket;
  function Consumer() { useConnection(undefined, callbacks); return null; }
  const render = () => transport === 'shared' ? createElement(DesktopWebSocketProvider, null, createElement(Consumer)) : createElement(Consumer);
  try {
    for (let repeat = 0; repeat < 3; repeat++) {
      await act(async () => root.render(render()));
      const socket = Socket.instances.at(-1)!; expect(socket).toBeDefined(); socket.readyState = 1;
      await act(async () => socket.message(true));
      expect(detected).not.toHaveBeenCalled();
      await act(async () => root.render(null));
    }
    expect(write).toHaveBeenCalledTimes(3);
    await act(async () => root.render(render()));
    const socket = Socket.instances.at(-1)!; socket.readyState = 1;
    await act(async () => socket.message()); expect(detected).toHaveBeenCalledTimes(1);
    handle.clearDetectedPreview(61234);
    await act(async () => socket.message(true)); expect(detected).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    handle = makeHandle();
    await act(async () => root.render(render()));
    const reopened = Socket.instances.at(-1)!; reopened.readyState = 1;
    await act(async () => reopened.message(true)); expect(detected).toHaveBeenCalledTimes(1);
    await act(async () => reopened.message(false, 61234, true)); expect(detected).toHaveBeenCalledTimes(1);
    expect(Object.values(window.localStorage).some(value => String(value).includes('61234'))).toBe(true);
    await act(async () => reopened.message(false, 61235)); expect(detected).toHaveBeenCalledTimes(2);
    const coldScope = `persisted-browser-${transport}`;
    window.localStorage.setItem(`o8:preview-announcements:v1:${coldScope}`, JSON.stringify([JSON.stringify(['terminal-owned', 61234])]));
    handle = makeHandle(coldScope);
    await act(async () => reopened.message(false, 61234, true)); expect(detected).toHaveBeenCalledTimes(2);
    handle = makeHandle(`different-browser-workspace-${transport}`);
    await act(async () => reopened.message(false, 61234)); expect(detected).toHaveBeenCalledTimes(3);
  } finally { await act(async () => root.unmount()); host.remove(); meta.remove(); window.localStorage.clear(); vi.unstubAllGlobals(); }
});
