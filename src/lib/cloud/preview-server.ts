import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { previewBindingCurrent, type PreviewBinding } from './preview-authority';
import { validPreviewPath } from './preview-contract';
import { requestPreview } from './preview-relay';

const LIFETIME_MS = 10 * 60_000;
const listeners = globalThis as typeof globalThis & { __o8PreviewServers?: Map<string, () => void> };
const servers = listeners.__o8PreviewServers ??= new Map<string, () => void>();
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; sandbox allow-scripts allow-same-origin";
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function refuse(response: ServerResponse, status: number) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP });
  response.end('Remote preview is unavailable. Refresh the task to reconnect.');
}

/** Project bytes never traverse the privileged coordinator origin or native webview. */
export async function openPreviewServer(binding: PreviewBinding, operatorOrigin: string) {
  if (!previewBindingCurrent(binding) || servers.size >= 8) throw new Error('Remote preview is unavailable.');
  const ticket = randomBytes(32).toString('hex');
  const id = randomBytes(24).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const cookie = `o8_preview_${randomBytes(12).toString('hex')}`;
  const operatorHash = hash(getOrCreateWsToken());
  const expiresAt = Date.now() + LIFETIME_MS;
  let origin = '';
  let bootstrapped = false;
  const current = () => {
    try { return Date.now() < expiresAt && equal(hash(getOrCreateWsToken()), operatorHash) && previewBindingCurrent(binding); }
    catch { return false; }
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (!origin || request.headers.host !== new URL(origin).host || !current()) { refuse(response, 409); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { refuse(response, 405); return; }
    const url = new URL(request.url ?? '/', origin);
    if (url.origin !== origin) { refuse(response, 403); return; }
    if (!bootstrapped && url.pathname === '/__o8_connect' && equal(url.searchParams.get('ticket') ?? '', ticket)) {
      bootstrapped = true;
      response.writeHead(303, {
        Location: binding.service.path,
        'Set-Cookie': `${cookie}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600`,
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': CSP,
      });
      response.end(); return;
    }
    const presented = (request.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookie}=`))?.slice(cookie.length + 1) ?? '';
    if (!bootstrapped || !equal(presented, secret)
      || (request.headers.origin && request.headers.origin !== origin)
      || request.headers['sec-fetch-site'] === 'cross-site' || request.headers['sec-fetch-site'] === 'same-site') {
      refuse(response, 403); return;
    }
    const path = url.pathname + url.search;
    if (!validPreviewPath(path)) { refuse(response, 400); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.once('close', abort);
    try {
      const result = await requestPreview(binding, path, request.method, controller.signal);
      if (!result || !current()) { refuse(response, 409); return; }
      if (result.status >= 300 && result.status < 400) { refuse(response, 502); return; }
      response.writeHead(result.status, {
        'Content-Type': result.contentType || 'application/octet-stream',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `${CSP}; frame-ancestors ${operatorOrigin}`,
      });
      response.end(request.method === 'HEAD' ? undefined : Buffer.from(result.body, 'base64'));
    } finally { response.removeListener('close', abort); }
  };
  const server = createServer((request, response) => { void handle(request, response).catch(() => refuse(response, 503)); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 16;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => { if (timer) clearInterval(timer); servers.delete(id); server.closeAllConnections(); server.close(); };
  try {
    // IPv6 loopback is outside the main webview's localhost/127.0.0.1 capability
    // allowlist and cookie host. No fallback to a privileged origin is permitted.
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '::1', resolve); });
    origin = `http://[::1]:${(server.address() as AddressInfo).port}`;
    servers.set(id, close);
    timer = setInterval(() => { if (!current()) close(); }, 1_000);
    timer.unref();
    server.unref();
    if (!current()) { close(); throw new Error('Remote execution changed.'); }
    return { id, url: `${origin}/__o8_connect?ticket=${ticket}`, expiresAt: new Date(expiresAt).toISOString(), close };
  } catch (error) { close(); throw error; }
}

export function closePreviewServers(): void { for (const close of servers.values()) close(); }
export function closePreviewServer(id: string): void { servers.get(id)?.(); }
