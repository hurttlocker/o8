import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';

import type { RelayServer } from './relay.js';

/**
 * Route WebSocket upgrades on ONE port to the relay concentrator by path:
 *   /mac                 — the Mac connector
 *   /device/{routingId}  — a phone
 *   /machine             — an account-machine connector
 *   /web/machine/{id}    — an account-authenticated web edge
 *   /web/{id}/surface/ws — the cookie-authenticated browser realtime edge
 * PURE (no env import) so index.ts (production) and scripts/verify-relay-e2e.ts
 * (a raw node http server) share the exact same routing.
 */

const DEVICE_RE = /^\/device\/([A-Za-z0-9]{1,64})\/?$/;
const WEB_MACHINE_RE = /^\/web\/machine\/([A-Za-z0-9_-]{1,128})\/?$/;
const WEB_SURFACE_WS_RE = /^\/web\/([A-Za-z0-9_-]{1,128})\/surface\/ws\/?$/;
const MAX_FRAME_BYTES = 1024 * 1024;

export interface UpgradableServer {
  on(event: 'upgrade', cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void;
}

function refuse(socket: Duplex, status: number, message: string): void {
  // `end(data)` flushes the HTTP response then sends FIN, so the ws client parses
  // a proper `unexpected-response` (e.g. 429) instead of a bare connection reset.
  try {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
}

export function attachRelayUpgrade(server: UpgradableServer, relay: RelayServer): void {
  const wsOptions = {
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  } as const;
  const macWss = new WebSocketServer(wsOptions);
  const deviceWss = new WebSocketServer(wsOptions);
  const machineWss = new WebSocketServer(wsOptions);
  const webMachineWss = new WebSocketServer(wsOptions);
  const webSurfaceWss = new WebSocketServer(wsOptions);

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '', 'http://relay.local').pathname;
    } catch {
      refuse(socket, 400, 'Bad Request');
      return;
    }

    if (pathname === '/mac') {
      macWss.handleUpgrade(req, socket, head, (ws) => {
        void relay.onMacConnected(ws, req);
      });
      return;
    }

    if (pathname === '/machine') {
      machineWss.handleUpgrade(req, socket, head, (ws) => {
        void relay.onMachineConnected(ws, req);
      });
      return;
    }

    const webMachineMatch = WEB_MACHINE_RE.exec(pathname);
    if (webMachineMatch) {
      const machineId = webMachineMatch[1]!;
      webMachineWss.handleUpgrade(req, socket, head, (ws) => {
        void relay.onWebMachineConnected(ws, machineId, req);
      });
      return;
    }

    const webSurfaceMatch = WEB_SURFACE_WS_RE.exec(pathname);
    if (webSurfaceMatch) {
      const machineId = webSurfaceMatch[1]!;
      webSurfaceWss.handleUpgrade(req, socket, head, (ws) => {
        void relay.onBrowserSurfaceConnected(ws, machineId, req);
      });
      return;
    }

    const m = DEVICE_RE.exec(pathname);
    if (m) {
      const routingId = m[1]!;
      // Per-minute connect gate BEFORE accepting the socket (cheapest refusal).
      if (!relay.allowDeviceConnect(routingId, req.socket.remoteAddress)) {
        refuse(socket, 429, 'Too Many Requests');
        return;
      }
      deviceWss.handleUpgrade(req, socket, head, (ws) => {
        relay.onDeviceConnected(ws, routingId);
      });
      return;
    }

    refuse(socket, 404, 'Not Found');
  });
}
