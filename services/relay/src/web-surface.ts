import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { Hono, type Context } from 'hono';
import type { WebSocket } from 'ws';

import type { RelayServer } from './relay.js';
import {
  isAllowedWebOrigin,
  webSessionCookie,
  webSessionTicketFromCookie,
} from './web-ticket.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 55_000;
const RELAY_WEB_ORIGIN = 'https://relay.o8.run';
const RESPONSE_HEADER_NAMES = [
  'accept-ranges',
  'cache-control',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
  'vary',
] as const;
const REQUEST_HEADER_NAMES = [
  'accept',
  'accept-language',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'range',
] as const;

export interface WebSurfaceRouteOptions {
  maxTunnelBytes: number;
  now?: () => number;
  relayOrigin?: string;
  requestTimeoutMs?: number;
}

export function createWebSurfaceApp(
  relay: RelayServer,
  options: WebSurfaceRouteOptions,
): Hono {
  const app = new Hono();
  registerWebSurfaceRoutes(app, relay, options);
  return app;
}

interface SurfaceResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

interface HttpResponseFrame {
  t: 'http-res' | 'http-res-part';
  rid: string;
  status?: number;
  headers?: Record<string, unknown>;
  bodyB64?: string;
  error?: string;
  last?: boolean;
}

class SurfaceMuxPeer extends EventEmitter {
  readyState = 1;
  private closed = false;

  constructor(
    private readonly outbound: (data: string) => void,
    private readonly closedByRelay: (code: number, reason: string) => void,
  ) {
    super();
  }

  send(data: string | Buffer): void {
    if (this.closed) return;
    this.outbound(Buffer.isBuffer(data) ? data.toString('utf8') : data);
  }

  close(code = 1000, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.closedByRelay(code, reason ?? '');
    this.emit('close', code, Buffer.from(reason ?? '', 'utf8'));
  }

  deliver(data: string): void {
    if (!this.closed) this.emit('message', Buffer.from(data, 'utf8'));
  }
}

/**
 * Install the HTTPS half of a web-machine session. The browser carries only an
 * HttpOnly relay cookie; every request is re-authorized against the signed
 * machine claim and the relay's current live machine/account entry.
 */
export function registerWebSurfaceRoutes(
  app: Hono,
  relay: RelayServer,
  options: WebSurfaceRouteOptions,
): void {
  const now = options.now ?? Date.now;
  const relayOrigin = (options.relayOrigin ?? RELAY_WEB_ORIGIN).replace(/\/+$/, '');

  app.options('/web/session', (c) => preflight(c));
  app.options('/web/:machineId/surface/*', (c) => preflight(c));

  app.post('/web/session', async (c) => {
    const origin = c.req.header('origin');
    if (!isAllowedWebOrigin(origin)) {
      return c.json({ error: 'origin_not_allowed' }, 403);
    }
    const ticket = bearer(c.req.header('authorization'));
    const verified = await relay.verifyWebSessionTicket(ticket);
    if (!verified.ok) {
      return corsJson(c, origin, { error: 'web_ticket_invalid' }, 401);
    }
    const authorized = await relay.authorizeWebSurface(
      ticket,
      verified.claims.machineId,
    );
    if (!authorized.ok) {
      return corsJson(c, origin, { error: authorized.reason }, authorized.status);
    }
    const headers = corsHeaders(origin);
    headers.set(
      'set-cookie',
      webSessionCookie(ticket, authorized.claims.exp, now()),
    );
    return c.json({
      machineId: authorized.claims.machineId,
      expiresAt: new Date(authorized.claims.exp * 1_000).toISOString(),
    }, 200, Object.fromEntries(headers));
  });

  app.all('/web/:machineId/surface/*', async (c) => {
    const origin = c.req.header('origin');
    if (!requestOriginAllowed(origin, relayOrigin)) {
      return c.json({ error: 'origin_not_allowed' }, 403);
    }
    const machineId = c.req.param('machineId');
    const ticket = webSessionTicketFromCookie(c.req.header('cookie'));
    const authorized = await relay.authorizeWebSurface(ticket, machineId);
    if (!authorized.ok) {
      return c.json({ error: authorized.reason }, authorized.status);
    }

    const length = Number.parseInt(c.req.header('content-length') ?? '0', 10);
    if (Number.isFinite(length) && length > options.maxTunnelBytes) {
      return c.json({ error: 'tunnel_request_too_large' }, 413);
    }
    const requestBody = c.req.method === 'GET' || c.req.method === 'HEAD'
      ? undefined
      : Buffer.from(await c.req.arrayBuffer());
    if (requestBody && requestBody.length > options.maxTunnelBytes) {
      return c.json({ error: 'tunnel_request_too_large' }, 413);
    }

    const path = localSurfacePath(c, machineId);
    let response: SurfaceResponse;
    try {
      response = await requestThroughMachine(
        relay,
        machineId,
        authorized.claims.accountId,
        {
          rid: randomUUID(),
          method: c.req.method,
          path,
          headers: requestHeaders(c.req.raw.headers),
          ...(requestBody?.length ? { bodyB64: requestBody.toString('base64') } : {}),
        },
        {
          timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          signal: c.req.raw.signal,
        },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'surface_proxy_failed';
      const status = reason === 'machine_offline' || reason === 'machine_disconnected'
        ? 503
        : reason === 'tunnel_request_timeout'
          ? 504
          : 502;
      return c.json({ error: reason }, status);
    }

    const headers = response.headers;
    applyCors(headers, origin);
    if (isHtml(headers)) {
      const body = Buffer.from(await new Response(response.body).arrayBuffer());
      const rewritten = rewriteSurfaceHtml(body.toString('utf8'), machineId);
      headers.set('content-length', String(Buffer.byteLength(rewritten)));
      headers.set(
        'content-security-policy',
        "frame-ancestors https://o8.run https://www.o8.run",
      );
      return new Response(c.req.method === 'HEAD' ? null : rewritten, {
        status: response.status,
        headers,
      });
    }
    if (isCss(headers)) {
      const body = Buffer.from(await new Response(response.body).arrayBuffer());
      const rewritten = rewriteSurfaceCss(body.toString('utf8'), machineId);
      headers.set('content-length', String(Buffer.byteLength(rewritten)));
      return new Response(c.req.method === 'HEAD' ? null : rewritten, {
        status: response.status,
        headers,
      });
    }
    return new Response(
      responseHasBody(c.req.method, response.status) ? response.body : null,
      { status: response.status, headers },
    );
  });
}

async function requestThroughMachine(
  relay: RelayServer,
  machineId: string,
  accountId: string,
  request: Record<string, unknown>,
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<SurfaceResponse> {
  const rid = String(request.rid);
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let started = false;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let resolveStart: (value: SurfaceResponse) => void = () => undefined;
  let rejectStart: (reason: Error) => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const response = new Promise<SurfaceResponse>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    timeout = null;
    options.signal.removeEventListener('abort', abort);
  };
  const abort = () => {
    if (settled) return;
    peer.deliver(JSON.stringify({ t: 'http-cancel', rid }));
    peer.close(1000, 'client_cancelled');
  };

  const peer = new SurfaceMuxPeer(
    (raw) => {
      const frame = parseResponseFrame(raw, rid);
      if (!frame) return;
      if (frame.t === 'http-res' && !started) {
        started = true;
        resolveStart({
          status: validStatus(frame.status),
          headers: responseHeaders(frame.headers),
          body,
        });
      }
      if (!started) return;
      const chunk = decodeBody(frame.bodyB64);
      if (chunk.length) controller?.enqueue(chunk);
      if (frame.last === true || (frame.last === undefined && frame.error)) {
        settled = true;
        cleanup();
        controller?.close();
        peer.close(1000, 'http_complete');
      }
    },
    (code, reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error(
        code === 1012 ? 'machine_disconnected' : reason || 'surface_stream_closed',
      );
      if (!started) rejectStart(error);
      else controller?.error(error);
    },
  );

  if (!relay.attachAuthorizedWebSurface(
    peer as unknown as WebSocket,
    machineId,
    accountId,
  )) {
    peer.close(1013, 'machine_offline');
    throw new Error('machine_offline');
  }

  options.signal.addEventListener('abort', abort, { once: true });
  timeout = setTimeout(() => {
    if (settled) return;
    peer.deliver(JSON.stringify({ t: 'http-cancel', rid }));
    peer.close(1000, 'tunnel_request_timeout');
  }, options.timeoutMs);
  timeout.unref?.();

  peer.deliver(JSON.stringify({ t: 'http-req', ...request }));
  return response;
}

function parseResponseFrame(raw: string, rid: string): HttpResponseFrame | null {
  try {
    const value = JSON.parse(raw) as Partial<HttpResponseFrame>;
    if (
      (value.t !== 'http-res' && value.t !== 'http-res-part')
      || value.rid !== rid
    ) {
      return null;
    }
    return value as HttpResponseFrame;
  } catch {
    return null;
  }
}

function responseHeaders(value: Record<string, unknown> | undefined): Headers {
  const headers = new Headers();
  for (const name of RESPONSE_HEADER_NAMES) {
    const candidate = value?.[name];
    if (typeof candidate === 'string' && candidate) headers.set(name, candidate);
  }
  return headers;
}

function requestHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of REQUEST_HEADER_NAMES) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

function localSurfacePath(c: Context, machineId: string): string {
  const url = new URL(c.req.url);
  const prefix = surfacePrefix(machineId);
  const pathname = url.pathname.startsWith(`${prefix}/`)
    ? url.pathname.slice(prefix.length)
    : '/mobile';
  return `${pathname}${url.search}`;
}

function rewriteSurfaceHtml(html: string, machineId: string): string {
  const prefix = surfacePrefix(machineId);
  const rewritten = html.replace(
    /=(["'])\/(?!\/)/g,
    (_match, quote: string) => `=${quote}${prefix}/`,
  );
  const script = `<script>${browserBridgeScript(prefix)}</script>`;
  return rewritten.includes('</head>')
    ? rewritten.replace('</head>', `${script}</head>`)
    : `${script}${rewritten}`;
}

function rewriteSurfaceCss(css: string, machineId: string): string {
  const prefix = surfacePrefix(machineId);
  return css.replace(
    /url\(\s*(["']?)\/(?!\/)/g,
    (_match, quote: string) => `url(${quote}${prefix}/`,
  );
}

function browserBridgeScript(prefix: string): string {
  return `(function(){if(window.__O8_WEB_MACHINE_TRANSPORT__)return;`
    + `var p=${JSON.stringify(prefix)},f=window.fetch.bind(window),W=window.WebSocket;`
    + `function u(v){try{var r=typeof v==='string'?v:(v instanceof Request?v.url:`
    + `(v instanceof URL?v.href:String(v)));var x=new URL(r,location.href);`
    + `if(x.origin===location.origin&&x.pathname.indexOf(p+'/')!==0){x.pathname=p+x.pathname;}`
    + `return x.toString();}catch(e){return v;}}`
    + `window.__O8_WEB_MACHINE_TRANSPORT__={fetch:function(i,n){`
    + `var q=i instanceof Request?new Request(u(i),i):u(i);`
    + `return f(q,Object.assign({},n||{},{credentials:'include'}));},`
    + `openWebSocket:function(){var x=new URL(p+'/ws',location.href);`
    + `x.protocol=location.protocol==='https:'?'wss:':'ws:';return new W(x);}};`
    + `function B(x,q){try{var v=new URL(x,location.href);if(v.pathname==='/ws'){`
    + `v=new URL(p+'/ws',location.href);v.protocol=location.protocol==='https:'?'wss:':'ws:';`
    + `return q===undefined?new W(v):new W(v,q);}}catch(e){}`
    + `return q===undefined?new W(x):new W(x,q);}B.prototype=W.prototype;`
    + `Object.setPrototypeOf(B,W);window.WebSocket=B;`
    + `var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,x){`
    + `arguments[1]=u(x);return o.apply(this,arguments);};`
    + `var a=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){`
    + `if((n==='src'||n==='href'||n==='action'||n==='poster')&&typeof v==='string')v=u(v);`
    + `return a.call(this,n,v);};`
    + `[['HTMLScriptElement','src'],['HTMLLinkElement','href'],['HTMLImageElement','src']].forEach(function(k){`
    + `var C=window[k[0]],d=C&&Object.getOwnPropertyDescriptor(C.prototype,k[1]);`
    + `if(!d||!d.get||!d.set)return;Object.defineProperty(C.prototype,k[1],{configurable:true,`
    + `enumerable:d.enumerable,get:d.get,set:function(v){return d.set.call(this,u(v));}});});})();`;
}

function surfacePrefix(machineId: string): string {
  return `/web/${encodeURIComponent(machineId)}/surface`;
}

function isHtml(headers: Headers): boolean {
  return headers.get('content-type')?.toLowerCase().includes('text/html') ?? false;
}

function isCss(headers: Headers): boolean {
  return headers.get('content-type')?.toLowerCase().includes('text/css') ?? false;
}

function decodeBody(value: string | undefined): Uint8Array {
  return typeof value === 'string' && value ? Buffer.from(value, 'base64') : new Uint8Array();
}

function validStatus(value: number | undefined): number {
  return typeof value === 'number' && value >= 100 && value <= 599 ? value : 502;
}

function responseHasBody(method: string, status: number): boolean {
  return method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304;
}

function bearer(value: string | undefined): string {
  return value?.replace(/^Bearer\s+/i, '').trim() ?? '';
}

function requestOriginAllowed(origin: string | undefined, relayOrigin: string): boolean {
  return !origin || origin === relayOrigin || isAllowedWebOrigin(origin);
}

function preflight(c: Context): Response {
  const origin = c.req.header('origin');
  if (!isAllowedWebOrigin(origin)) {
    return c.json({ error: 'origin_not_allowed' }, 403);
  }
  const headers = corsHeaders(origin);
  headers.set('access-control-allow-headers', 'authorization, content-type, range');
  headers.set('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('access-control-max-age', '600');
  return new Response(null, { status: 204, headers });
}

function corsJson(
  c: Context,
  origin: string,
  value: { error: string },
  status: 401 | 403 | 503,
): Response {
  return c.json(value, status, Object.fromEntries(corsHeaders(origin)));
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    'access-control-allow-credentials': 'true',
    'access-control-allow-origin': origin,
    vary: 'Origin',
  });
}

function applyCors(headers: Headers, origin: string | undefined): void {
  if (!origin || !isAllowedWebOrigin(origin)) return;
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-credentials', 'true');
  const vary = headers.get('vary');
  headers.set('vary', vary ? `${vary}, Origin` : 'Origin');
}
