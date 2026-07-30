import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
const COOKIE = '__Host-o8-web-session';
const RELAY_ORIGIN = 'https://relay.o8.run';
const WEB_ORIGINS = new Set(['https://o8.run', 'https://www.o8.run', 'https://app.o8.run']);
const RESPONSE_HEADERS = [
  'accept-ranges', 'cache-control', 'content-language', 'content-length', 'content-range',
  'content-type', 'etag', 'last-modified', 'vary',
];
const REQUEST_HEADERS = [
  'accept', 'accept-language', 'content-type', 'if-match', 'if-modified-since', 'if-none-match',
  'if-range', 'if-unmodified-since', 'range',
];
type MachineVerdict =
  | { ok: true; claims: { accountId: string; machineId: string; installId: string; exp: number } }
  | { ok: false; reason: string };
type WebVerdict =
  | { ok: true; claims: { accountId: string; machineId: string; exp: number } }
  | { ok: false; reason: string };
type Authorization =
  | { ok: true; accountId: string; machineId: string; exp: number }
  | { ok: false; status: 401 | 403 | 503; reason: string };
type Peer = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  terminate?: () => void; on: (event: string, listener: (...args: unknown[]) => void) => unknown;
};
export interface ReferenceRelayOptions {
  verifyMachineTicket: (token: string) => Promise<MachineVerdict>;
  verifyWebTicket: (token: string) => Promise<WebVerdict>;
  authorizeWebMachine: (token: string, machineId: string) => Promise<boolean>;
  heartbeatMachine?: () => Promise<unknown>; machineHeartbeatMs?: number;
}
/**
 * Test-only reference for the public account-machine wire contract. It models
 * admission and mux behavior independently; it is not the hosted relay.
 */
export class RelayServer {
  private machine: { machineId: string; accountId: string; peer: Peer } | null = null;
  private readonly sessions = new Map<string, { machineId: string; peer: Peer }>();
  private readonly peerSids = new Map<Peer, string>();
  private sid = 0;
  constructor(private readonly options: ReferenceRelayOptions) {}
  async onMachine(peer: Peer, req: IncomingMessage): Promise<void> {
    const machineId = header(req, 'x-o8-machine-id');
    const verdict = await this.options.verifyMachineTicket(bearer(header(req, 'authorization')));
    if (!machineId || !verdict.ok || verdict.claims.machineId !== machineId) {
      peer.close(4409, !machineId ? 'missing_machine_id' : 'machine_ticket_invalid');
      return;
    }
    const previous = this.machine;
    this.machine = { machineId, accountId: verdict.claims.accountId, peer };
    previous?.peer.close(1001, 'superseded');
    peer.on('message', (raw) => this.onMachineMessage(peer, raw));
    peer.on('close', () => this.onMachineClosed(peer));
    peer.on('error', () => undefined);
    for (const [sid, session] of this.sessions) {
      if (session.machineId !== machineId) continue;
      send(peer, { t: 'mux-open', sid });
      send(session.peer, { t: 'presence', machine: 'up' });
    }
    send(peer, { t: 'devices', count: 0 });
  }
  async onAccountWeb(peer: Peer, machineId: string, req: IncomingMessage): Promise<void> {
    const token = bearer(header(req, 'authorization'));
    if (!token || !await this.options.authorizeWebMachine(token, machineId)) {
      peer.close(1008, 'machine_not_owned');
      return;
    }
    this.attach(peer, machineId);
  }
  async onBrowserWeb(peer: Peer, machineId: string, req: IncomingMessage): Promise<void> {
    if (!originAllowed(header(req, 'origin'))) {
      peer.close(4403, 'origin_not_allowed');
      return;
    }
    const authorized = await this.authorize(cookieTicket(header(req, 'cookie')), machineId);
    if (!authorized.ok) {
      const code = authorized.status === 401 ? 4401 : authorized.status === 503 ? 1013 : 4403;
      peer.close(code, authorized.reason);
      return;
    }
    this.attach(peer, machineId);
  }
  async authorize(ticket: string, requestedMachineId?: string): Promise<Authorization> {
    const verdict = await this.options.verifyWebTicket(ticket);
    if (!verdict.ok) return { ok: false, status: 401, reason: 'web_ticket_invalid' };
    const machineId = requestedMachineId ?? verdict.claims.machineId;
    if (verdict.claims.machineId !== machineId) return { ok: false, status: 403, reason: 'machine_mismatch' };
    if (!this.machine || this.machine.machineId !== machineId) return { ok: false, status: 503, reason: 'machine_offline' };
    if (this.machine.accountId !== verdict.claims.accountId) return { ok: false, status: 403, reason: 'machine_not_owned' };
    return { ok: true, machineId, accountId: verdict.claims.accountId, exp: verdict.claims.exp };
  }
  attach(peer: Peer, machineId: string): boolean {
    const sid = `m${++this.sid}`;
    this.sessions.set(sid, { machineId, peer });
    this.peerSids.set(peer, sid);
    peer.on('message', (raw) => this.onWebMessage(peer, raw));
    peer.on('close', () => this.onWebClosed(peer));
    peer.on('error', () => undefined);
    if (this.machine?.machineId === machineId) {
      send(this.machine.peer, { t: 'mux-open', sid });
      send(peer, { t: 'presence', machine: 'up' });
    } else send(peer, { t: 'presence', machine: 'down' });
    return this.machine?.machineId === machineId;
  }
  stats(): { machines: number } { return { machines: this.machine ? 1 : 0 }; }
  stop(): void {
    this.machine?.peer.terminate?.();
    for (const session of this.sessions.values()) session.peer.terminate?.();
  }
  private onMachineMessage(peer: Peer, raw: unknown): void {
    if (this.machine?.peer !== peer) return;
    const frame = record(raw);
    const sid = typeof frame?.sid === 'string' ? frame.sid : '';
    const session = this.sessions.get(sid);
    if (!session) return;
    if (frame?.t === 'mux' && typeof frame.payload === 'string') {
      session.peer.send(Buffer.from(frame.payload, 'base64').toString('utf8'));
    } else if (frame?.t === 'mux-close') {
      const code = frame.code === 4401 || frame.code === 4403 ? frame.code : 1000;
      session.peer.close(code, typeof frame.reason === 'string' ? frame.reason : '');
    }
  }
  private onMachineClosed(peer: Peer): void {
    if (this.machine?.peer !== peer) return;
    const machineId = this.machine.machineId;
    this.machine = null;
    for (const session of [...this.sessions.values()]) {
      if (session.machineId !== machineId) continue;
      send(session.peer, { t: 'presence', machine: 'down' });
      session.peer.close(1012, 'machine_disconnected');
    }
  }
  private onWebMessage(peer: Peer, raw: unknown): void {
    const sid = this.peerSids.get(peer);
    if (!sid || !this.machine) return;
    send(this.machine.peer, {
      t: 'mux', sid, seq: 0,
      payload: Buffer.from(rawText(raw), 'utf8').toString('base64'),
    });
  }
  private onWebClosed(peer: Peer): void {
    const sid = this.peerSids.get(peer);
    if (!sid) return;
    this.peerSids.delete(peer);
    this.sessions.delete(sid);
    if (this.machine) send(this.machine.peer, { t: 'mux-close', sid });
  }
}
export function attachRelayUpgrade(
  server: { on: (event: 'upgrade', cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) => void },
  relay: RelayServer,
): void {
  const wss = new WebSocketServer({
    noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false, clientTracking: false,
  });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://reference.relay').pathname;
    const account = /^\/web\/machine\/([A-Za-z0-9_-]{1,128})\/?$/.exec(path);
    const browser = /^\/web\/([A-Za-z0-9_-]{1,128})\/surface\/ws\/?$/.exec(path);
    if (path !== '/machine' && !account && !browser) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const peer = ws as unknown as Peer;
      if (path === '/machine') void relay.onMachine(peer, req);
      else if (account) void relay.onAccountWeb(peer, account[1]!, req);
      else if (browser) void relay.onBrowserWeb(peer, browser[1]!, req);
    });
  });
}
class SurfacePeer extends EventEmitter {
  readyState = 1;
  private closed = false;
  constructor(private readonly outbound: (raw: string) => void, private readonly rejected: (reason: Error) => void) {
    super();
  }
  send(raw: string): void { if (!this.closed) this.outbound(raw); }
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true; this.readyState = 3;
    this.rejected(new Error(code === 1012 ? 'machine_disconnected' : reason));
    this.emit('close');
  }
  deliver(raw: string): void { if (!this.closed) this.emit('message', Buffer.from(raw)); }
}
export function createWebSurfaceApp(
  relay: RelayServer,
  options: { maxTunnelBytes: number; requestTimeoutMs?: number },
): { request: (input: string | URL | Request, init?: RequestInit) => Promise<Response> } {
  return {
    request: async (input, init) => {
      const req = input instanceof Request ? input : new Request(new URL(String(input), RELAY_ORIGIN), init);
      const url = new URL(req.url);
      const origin = req.headers.get('origin') ?? '';
      if (url.pathname === '/web/session' && req.method === 'POST') {
        if (!WEB_ORIGINS.has(origin)) return json(403, 'origin_not_allowed');
        const ticket = bearer(req.headers.get('authorization') ?? '');
        const authorized = await relay.authorize(ticket);
        if (!authorized.ok) return json(authorized.status, authorized.reason, origin);
        const age = Math.max(0, authorized.exp - Math.floor(Date.now() / 1_000));
        const cookie = `${COOKIE}=${ticket}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;
        return json(200, '', origin, cookie, {
          machineId: authorized.machineId, expiresAt: new Date(authorized.exp * 1_000).toISOString(),
        });
      }
      const match = /^\/web\/([A-Za-z0-9_-]{1,128})\/surface(\/.*)?$/.exec(url.pathname);
      if (!match) return json(404, 'not_found');
      if (origin && !originAllowed(origin)) return json(403, 'origin_not_allowed');
      const authorized = await relay.authorize(cookieTicket(req.headers.get('cookie') ?? ''), match[1]!);
      if (!authorized.ok) return json(authorized.status, authorized.reason);
      if (Number(req.headers.get('content-length') ?? 0) > options.maxTunnelBytes) return json(413, 'tunnel_request_too_large');
      const response = await requestThroughRelay(relay, authorized.machineId, {
        t: 'http-req',
        rid: randomUUID(),
        method: req.method,
        path: `${match[2] || '/mobile'}${url.search}`,
        headers: requestHeaders(req.headers),
      }, options.requestTimeoutMs ?? 5_000);
      if (!response.headers.get('content-type')?.includes('text/html')) return response;
      const body = rewriteHtml(await response.text(), authorized.machineId);
      response.headers.set('content-length', String(Buffer.byteLength(body)));
      response.headers.set('content-security-policy', `frame-ancestors ${[...WEB_ORIGINS].join(' ')}`);
      return new Response(body, response);
    },
  };
}
async function requestThroughRelay(
  relay: RelayServer, machineId: string, request: Record<string, unknown>, timeoutMs: number,
): Promise<Response> {
  const rid = String(request.rid);
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let status = 502;
    let headers = new Headers();
    const chunks: Buffer[] = [];
    const finish = (value: Response | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.close(1000, 'http_complete');
      if (value instanceof Error) reject(value); else resolve(value);
    };
    const peer = new SurfacePeer((raw) => {
      const frame = record(raw);
      if (frame?.rid !== rid || (frame.t !== 'http-res' && frame.t !== 'http-res-part')) return;
      if (frame.t === 'http-res') {
        status = typeof frame.status === 'number' ? frame.status : 502;
        headers = selectedHeaders(frame.headers, RESPONSE_HEADERS);
      }
      if (typeof frame.bodyB64 === 'string' && frame.bodyB64) chunks.push(Buffer.from(frame.bodyB64, 'base64'));
      if (frame.last === true || (frame.last === undefined && frame.error)) {
        finish(new Response(new Uint8Array(Buffer.concat(chunks)), { status, headers }));
      }
    }, (error) => finish(error));
    const timer = setTimeout(() => finish(new Error('tunnel_request_timeout')), timeoutMs);
    timer.unref?.();
    if (!relay.attach(peer as unknown as Peer, machineId)) return finish(new Error('machine_offline'));
    peer.deliver(JSON.stringify(request));
  });
}
function rewriteHtml(html: string, machineId: string): string {
  const prefix = `/web/${encodeURIComponent(machineId)}/surface`;
  const rewritten = html.replace(/=(["'])\/(?!\/)/g, (_match, quote: string) => `=${quote}${prefix}/`);
  const bridge = `<script>(function(){var p=${JSON.stringify(prefix)},f=window.fetch.bind(window);`
    + `window.__O8_WEB_MACHINE_TRANSPORT__={fetch:function(i,n){var u=new URL(typeof i==='string'?i:i.url,location.href);`
    + `if(u.origin===location.origin&&u.pathname.indexOf(p+'/')!==0)u.pathname=p+u.pathname;return f(u,n);},`
    + `openWebSocket:function(){var u=new URL(p+'/ws',location.href);u.protocol=location.protocol==='https:'?'wss:':'ws:';`
    + `return new WebSocket(u);}};})();</script>`;
  return rewritten.includes('</head>')
    ? rewritten.replace('</head>', `${bridge}</head>`)
    : `${bridge}${rewritten}`;
}
function selectedHeaders(value: unknown, names: string[]): Headers {
  const result = new Headers();
  const get = value instanceof Headers ? (name: string) => value.get(name) : (name: string) => (
    value && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined
  );
  for (const name of names) {
    const candidate = get(name);
    if (typeof candidate === 'string' && candidate) result.set(name, candidate);
  }
  return result;
}
function requestHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(REQUEST_HEADERS.flatMap((name) => {
    const value = headers.get(name);
    return value ? [[name, value]] : [];
  })) as Record<string, string>;
}
function json(
  status: number, error: string, origin = '', cookie = '', body: object = { error },
): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
    headers.set('vary', 'Origin');
  }
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}
function originAllowed(origin: string): boolean { return origin === RELAY_ORIGIN || WEB_ORIGINS.has(origin); }
function cookieTicket(cookie: string): string {
  return cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1) ?? '';
}
function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}
function bearer(value: string): string { return value.replace(/^Bearer\s+/i, '').trim(); }
function rawText(raw: unknown): string { return typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw); }
function record(raw: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawText(raw)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function send(peer: Peer, frame: object): void { if (peer.readyState === 1) peer.send(JSON.stringify(frame)); }
