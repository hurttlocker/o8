import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';

import type { RelayServer } from './relay.js';

/**
 * Route WebSocket upgrades on ONE port to the relay concentrator by path:
 *   /mac                 — the Mac connector
 *   /device/{routingId}  — a phone
 * PURE (no env import) so index.ts (production) and scripts/verify-relay-e2e.ts
 * (a raw node http server) share the exact same routing.
 */

const DEVICE_RE = /^\/device\/([A-Za-z0-9]{1,64})\/?$/;
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
