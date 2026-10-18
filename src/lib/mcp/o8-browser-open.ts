import { randomUUID } from 'node:crypto';
import { McpInputError } from '@/lib/mcp/api-error';
import { normalizeBrowserUrl } from '@/lib/browser/url';
import { BROWSER_OPEN_REQUEST_EVENT } from '@/lib/browser/open-request';
import type { O8WebviewClient } from '@/lib/mcp/o8-webview-client';

interface OpenReceipt extends Record<string, unknown> {
  ok: boolean;
  status: 'opened' | 'pending' | 'failed' | 'unavailable';
  requestId: string;
  automaticReplay: false;
}

type BrowserClient = Pick<O8WebviewClient, 'evalJs' | 'listWindows'>;

function dispatchScript(requestId: string, url: string | null, expiresAt: number): string {
  return `(() => {
    const requestId = ${JSON.stringify(requestId)}, url = ${JSON.stringify(url)};
    const requests = window.__o8BrowserOpenRequests || (window.__o8BrowserOpenRequests = new Map());
    if (requests.has(requestId)) return JSON.stringify({ requestId, duplicate: true });
    const now = Date.now();
    if (now > ${expiresAt}) return JSON.stringify({ requestId, expired: true });
    for (const [id, value] of requests) if (now - value.createdAt > 60000) requests.delete(id);
    if (requests.size >= 128) return JSON.stringify({ requestId, capacity: true });
    requests.set(requestId, { requestId, url, createdAt: now, accepted: false });
    window.dispatchEvent(new CustomEvent(${JSON.stringify(BROWSER_OPEN_REQUEST_EVENT)}, { detail: { requestId } }));
    return JSON.stringify({ requestId, dispatched: true });
  })()`;
}

function observeScript(requestId: string): string {
  return `(async () => {
    const requestId = ${JSON.stringify(requestId)};
    const request = window.__o8BrowserOpenRequests && window.__o8BrowserOpenRequests.get(requestId);
    const result = { ok: false, status: 'pending', requestId, automaticReplay: false, actionDispatched: !!request };
    if (!request) return JSON.stringify({ ...result, status: 'unavailable', reason: 'request-not-found', actionDispatched: null });
    if (request.error) return JSON.stringify({ ...result, status: 'failed', error: request.error });
    if (!request.accepted) return JSON.stringify({ ...result, reason: 'host-not-acknowledged' });
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
        && rect.left < innerWidth && rect.top < innerHeight
        && style.display !== 'none' && style.visibility !== 'hidden' && !el.closest('[inert]');
    };
    const host = Array.from(document.querySelectorAll('[data-o8-browser-host]')).find(el =>
      el.getAttribute('data-o8-browser-host') === request.scopeKey && el.getAttribute('data-o8-browser-visible') === 'true' && visible(el));
    if (!host) return JSON.stringify({ ...result, reason: 'browser-not-visible' });
    const rect = host.getBoundingClientRect();
    const geometry = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    if (!request.url) return JSON.stringify({ ...result, ok: true, status: 'opened', navigation: 'not-requested', panelGeometry: geometry });
    const sameUrl = value => { try { return new URL(value, location.href).href === new URL(request.url, location.href).href; } catch (_) { return false; } };
    const native = host.querySelector('[data-o8-native-browser="panel"]');
    if (native && visible(native)) {
      try {
        const raw = await window.__TAURI_INTERNALS__.invoke('browser_view_eval_result', {
          js: '({url:location.href,width:innerWidth,height:innerHeight,readyState:document.readyState})', timeoutMs: 1000,
        });
        const page = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (page && sameUrl(page.url) && page.width > 0 && page.height > 0 && page.readyState !== 'loading') {
          return JSON.stringify({ ...result, nativeCandidate: true, surface: 'native', requestedUrl: request.url, url: page.url, panelGeometry: geometry, childGeometry: { width: page.width, height: page.height } });
        }
        return JSON.stringify({ ...result, reason: 'navigation-not-confirmed', observedUrl: page && page.url });
      } catch (_) { return JSON.stringify({ ...result, reason: 'native-child-not-ready' }); }
    }
    const frame = host.querySelector('iframe[data-o8-browser="panel"]');
    if (frame && visible(frame)) {
      try {
        const page = frame.contentDocument;
        const actual = new URL(frame.contentWindow.location.href);
        if (actual.origin === location.origin && actual.pathname === '/api/browser/proxy') return JSON.stringify({ ...result, status: 'unavailable', reason: 'proxy-navigation-unverified' });
        if (page && page.readyState !== 'loading' && sameUrl(actual.href)) return JSON.stringify({ ...result, ok: true, status: 'opened', surface: 'iframe', requestedUrl: request.url, url: actual.href, panelGeometry: geometry });
      } catch (_) { return JSON.stringify({ ...result, status: 'unavailable', reason: 'frame-not-inspectable' }); }
    }
    return JSON.stringify({ ...result, reason: 'page-not-ready' });
  })()`;
}

async function bounded<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Browser observation timed out')), Math.max(1, deadline - Date.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function requestBrowserOpen(client: BrowserClient, args: Record<string, unknown>): Promise<OpenReceipt> {
  if (args.requestId !== undefined && (typeof args.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.requestId))) throw new McpInputError('requestId must be a previous Browser request identifier');
  if (args.url !== undefined && typeof args.url !== 'string') throw new McpInputError('url must be a string');
  if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs < 0 || args.timeoutMs > 10000)) throw new McpInputError('timeoutMs must be between 0 and 10000');
  const observing = typeof args.requestId === 'string';
  if (observing && args.url !== undefined) throw new McpInputError('Observe a previous requestId without a new url');
  const requestId = observing ? args.requestId as string : randomUUID();
  const timeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : 5000;
  const deadline = Date.now() + timeout;
  const pending: OpenReceipt = { ok: false, status: 'pending', requestId, automaticReplay: false, actionDispatched: null };
  if (!observing) {
    const url = typeof args.url === 'string' && args.url.trim() ? normalizeBrowserUrl(args.url) : null;
    if (url) {
      try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); }
      catch { throw new McpInputError('url must identify an HTTP or HTTPS page'); }
    }
    try {
      const dispatch = JSON.parse((await bounded(client.evalJs(dispatchScript(requestId, url, Date.now() + 10000)), deadline)).result) as { expired?: boolean; capacity?: boolean };
      if (dispatch.expired || dispatch.capacity) return { ...pending, status: 'unavailable', reason: dispatch.expired ? 'dispatch-expired' : 'request-capacity', actionDispatched: false };
    } catch { /* Dispatch may have succeeded. Observe the same request without repeating it. */ }
  }
  do {
    try {
      const value = JSON.parse((await bounded(client.evalJs(observeScript(requestId)), deadline)).result) as OpenReceipt;
      if (value.requestId !== requestId) return { ...pending, status: 'unavailable', reason: 'receipt-mismatch' };
      if (value.nativeCandidate) {
        const { windows } = await bounded(client.listWindows(), deadline);
        const child = windows.find(window => window.label === 'browser-view');
        if (child?.visible === true && child.innerSize && child.innerSize.width > 0 && child.innerSize.height > 0) {
          delete value.nativeCandidate;
          return { ...value, ok: true, status: 'opened', nativeWindowGeometry: child.innerSize };
        }
        Object.assign(pending, value, { reason: 'native-window-not-visible' });
        delete pending.nativeCandidate;
      } else if (value.status !== 'pending') return value;
      else Object.assign(pending, value);
    } catch { pending.reason = 'observation-unavailable'; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
  } while (Date.now() <= deadline);
  return pending;
}
