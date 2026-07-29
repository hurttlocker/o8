// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopWebSocketProvider } from './DesktopWebSocketContext';

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

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

let host: HTMLDivElement;
let root: Root;

function addMeta(name: string, content: string): void {
  const meta = document.createElement('meta');
  meta.setAttribute('name', name);
  meta.setAttribute('content', content);
  document.head.appendChild(meta);
}

describe('DesktopWebSocketProvider web-machine transport', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    addMeta('ws-token', 'local-token');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.head.querySelectorAll('meta').forEach((meta) => meta.remove());
    delete window.__O8_WEB_MACHINE_TRANSPORT__;
    vi.unstubAllGlobals();
  });

  it('opens /ws through the machine transport when the surface meta is present', () => {
    addMeta('o8-auth-mode', 'web-machine');
    const relayedSocket = new FakeWebSocket('relay-owned');
    FakeWebSocket.instances = [];
    const openWebSocket = vi.fn(() => relayedSocket as unknown as WebSocket);
    window.__O8_WEB_MACHINE_TRANSPORT__ = { openWebSocket };

    act(() => {
      root.render(createElement(
        DesktopWebSocketProvider,
        null,
        createElement('div'),
      ));
    });

    expect(openWebSocket).toHaveBeenCalledWith('/ws');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('keeps the existing direct socket URL when the surface meta is absent', () => {
    const openWebSocket = vi.fn();
    window.__O8_WEB_MACHINE_TRANSPORT__ = { openWebSocket };

    act(() => {
      root.render(createElement(
        DesktopWebSocketProvider,
        null,
        createElement('div'),
      ));
    });

    expect(openWebSocket).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual([
      'ws://localhost:47125/ws?token=local-token',
    ]);
  });
});
