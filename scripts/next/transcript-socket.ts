/** 20 Hz production history.snapshot envelopes for the owned transcript host. */
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export function attachTranscriptSocket(server: Server, token: string, requests: string[]) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(`WS ${url.pathname}`);
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== token) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ channel: 'system', event: 'connected', data: { bootId: 'transcript-fixture' } }));
    let timer: ReturnType<typeof setInterval> | undefined;
    ws.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      requests.push(`WS ${message.type}`);
      if (message.type === 'ping') { ws.send(JSON.stringify({ channel: 'pong', event: 'pong', data: {} })); return; }
      if (message.type !== 'realtime-subscribe' || message.subscriptions?.length !== 1 || timer) { ws.close(1008); return; }
      const stream = message.subscriptions[0].stream;
      if (stream !== 'session:llm-chat:thoughts-pagination') return;
      let seq = 1;
      ws.send(JSON.stringify({ channel: 'realtime', event: 'batch', data: { events: [{ stream,
        seq, capturedSeq: 0, event: 'history.snapshot', data: {
          sessionKey: 'llm-chat:thoughts-pagination', replace: true,
          entries: Array.from({ length: 200 }, (_, index) => ({ id: `page-${1801 + index}`,
            role: index % 2 ? 'assistant' : 'user', text: `History row ${1801 + index}`, timestamp: 1790814600000 + index * 1000 })),
        },
      }] } }));
      timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || seq >= 120) { clearInterval(timer); return; }
        seq++;
        ws.send(JSON.stringify({ channel: 'realtime', event: 'batch', data: { events: [{
          stream, seq, capturedSeq: seq - 1, event: 'history.snapshot', data: {
            sessionKey: 'llm-chat:thoughts-pagination', replace: false,
            entries: [{ id: 'page-2000', role: 'assistant', text: `History row 2000 · streaming revision ${seq}`,
              timestamp: 1790814799000 + seq }],
          },
        }] } }));
      }, 50);
    });
    ws.on('close', () => clearInterval(timer));
    ws.on('error', () => clearInterval(timer));
  });
  return () => { for (const ws of wss.clients) ws.terminate(); wss.close(); };
}
