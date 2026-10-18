// @vitest-environment jsdom
import { act, createElement, StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createO8WebviewToolHandlers } from './o8-webview-tools';
import type { O8WebviewClient } from './o8-webview-client';
import { useBrowserOpenRequests } from '@/app/dashboard/hooks/useBrowserOpenRequests';
import { O8BrowserPane } from '@/components/desktop/O8BrowserPane';
import { BROWSER_PANE_STORAGE_KEY, getBrowserPaneTabs } from '@/lib/browser/pane-state';

const fixture = vi.hoisted(() => ({ url: '', autoNavigate: true, nativeEnabled: true, nativeVisible: true, width: 500, height: 300, loseAck: false, replayDispatch: false, hostFails: false, opens: 0 }));
vi.mock('@/lib/browser-agent/page-agent', () => ({ installBrowserAgent: vi.fn() }));
vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/operator/use-native-browser-view', () => ({ useNativeBrowserViewFlag: () => fixture.nativeEnabled }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true, browserViewEval: vi.fn(), browserViewNavigate: vi.fn() }));
vi.mock('@/components/desktop/NativeBrowserSurface', () => ({
  NativeBrowserSurface: function NativeTransport({ url }: { url: string }) {
    useEffect(() => { if (fixture.autoNavigate) fixture.url = url; }, [url]);
    return createElement('div', { 'data-o8-native-browser': 'panel' });
  },
}));
vi.mock('@/components/desktop/O8EnginePane', () => ({ O8EnginePane: () => null }));

let root: Root | null = null;
const url = 'http://localhost:48234/fixture';
let scope = '';
let scopeCounter = 0;
const client = {
  evalJs: async (code: string) => {
    const result = await window.eval(code);
    if (fixture.loseAck && code.includes('new CustomEvent')) { fixture.loseAck = false; throw new Error('acknowledgement lost after dispatch'); }
    if (fixture.replayDispatch && code.includes('new CustomEvent')) { fixture.replayDispatch = false; await window.eval(code); }
    return { result };
  },
  listWindows: async () => ({ windows: [{ label: 'browser-view', visible: fixture.nativeVisible, innerSize: { width: fixture.width, height: fixture.height } }] }),
} as unknown as O8WebviewClient;
const handler = createO8WebviewToolHandlers(() => client).o8_view_open_browser;

function Host({ initial = 'collapsed' }: { initial?: 'collapsed' | 'hidden' | 'open' }) {
  const [visible, setVisible] = useState(initial !== 'collapsed');
  const [selected, setSelected] = useState(initial === 'open');
  const [target, setTarget] = useState(initial === 'open' ? 'http://localhost:48234/existing' : '');
  const open = useCallback((value?: string) => {
    fixture.opens++;
    if (fixture.hostFails) throw new Error('Browser host failed');
    setVisible(true); setSelected(true); if (value) setTarget(value);
  }, []);
  useBrowserOpenRequests(open, scope);
  return createElement('div', { 'data-o8-browser-host': scope, 'data-o8-browser-visible': visible && selected ? 'true' : 'false', style: { display: visible ? 'block' : 'none' } },
    createElement(O8BrowserPane, { navigateToUrl: target, stateScopeKey: scope }));
}

async function mount(initial: 'collapsed' | 'hidden' | 'open' = 'collapsed') {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(Host, { initial })));
}

async function request(args: Record<string, unknown>) {
  let pending: ReturnType<typeof handler>;
  await act(async () => { pending = handler(args); });
  const result = await pending!;
  return JSON.parse((result.content[0] as { text: string }).text);
}

beforeEach(() => {
  scope = `browser-open-fixture-${++scopeCounter}`;
  Object.assign(fixture, { url: '', autoNavigate: true, nativeEnabled: true, nativeVisible: true, width: 500, height: 300, loseAck: false, replayDispatch: false, hostFails: false, opens: 0 });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (_command: string, args: { js: string }) => {
    // WKWebView's result bridge JSON-encodes the evaluated value itself.
    const evaluate = new Function('location', 'innerWidth', 'innerHeight', 'document', `return ${args.js}`);
    return JSON.stringify(evaluate({ href: fixture.url }, fixture.width, fixture.height, { readyState: 'complete' }));
  } });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 5, y: 8, left: 5, top: 8, width: 500, height: 300, right: 505, bottom: 308, toJSON: () => ({}) });
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; delete window.__o8BrowserOpenRequests;
  document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('Browser-open completion through the actual MCP entry point', () => {
  it('does not call event dispatch a completed Browser navigation when no host acknowledges it', async () => {
    const client = {
      evalJs: async (code: string) => ({ result: await window.eval(code) }),
      listWindows: async () => ({ windows: [] }),
    } as unknown as O8WebviewClient;
    const handler = createO8WebviewToolHandlers(() => client).o8_view_open_browser;
    const result = await handler({ url: 'http://localhost:48234/fixture', timeoutMs: 0 });
    const receipt = JSON.parse((result.content[0] as { text: string }).text);
    expect(receipt).toMatchObject({ ok: false, status: 'pending', automaticReplay: false });
    expect(receipt.requestId).toBeTypeOf('string');
    expect(receipt.raw).toBeUndefined();
  });

  it.each(['collapsed', 'hidden', 'open'] as const)('reveals %s Browser through the real open hook and pane before completing', async (initial) => {
    await mount(initial);
    const result = await request({ url, timeoutMs: 700 });
    expect(result).toMatchObject({ ok: true, status: 'opened', url, automaticReplay: false, surface: 'native' });
    expect(result.childGeometry).toEqual({ width: 500, height: 300 });
    expect(fixture.opens).toBe(1);
    expect(getBrowserPaneTabs(scope).map(tab => tab.url)).toContain(url);
    if (initial === 'open') expect(getBrowserPaneTabs(scope).map(tab => tab.url)).toContain('http://localhost:48234/existing');
  });

  it('observes a lost acknowledgement without dispatching a second open or page tab', async () => {
    await mount(); fixture.loseAck = true;
    const first = await request({ url, timeoutMs: 700 });
    expect(first).toMatchObject({ ok: true, status: 'opened' });
    const observed = await request({ requestId: first.requestId, timeoutMs: 0 });
    expect(observed).toMatchObject({ ok: true, status: 'opened', requestId: first.requestId });
    expect(fixture.opens).toBe(1); expect(getBrowserPaneTabs(scope)).toHaveLength(1);
    const persisted = JSON.parse(localStorage.getItem(BROWSER_PANE_STORAGE_KEY)!).scopes.find((entry: { scopeKey: string }) => entry.scopeKey === scope);
    expect(persisted.tabs).toHaveLength(1); expect(persisted.tabs[0]).toMatchObject({ id: getBrowserPaneTabs(scope)[0].id, url });
  });

  it('finishes the initial requested navigation through a Strict Mode effect remount', async () => {
    fixture.url = url;
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(createElement(StrictMode, null,
      createElement(O8BrowserPane, { navigateToUrl: url, stateScopeKey: scope }))));
    expect(getBrowserPaneTabs(scope).map(tab => tab.url)).toEqual([url]);
    expect(document.querySelector('[data-o8-native-browser="panel"]')).not.toBeNull();
  });

  it('carries an accepted request into scoped navigation for the existing panel', async () => {
    await mount(); const navigation = vi.fn();
    window.addEventListener('o8:open-browser', navigation, { once: true });
    try {
      const result = await request({ url, timeoutMs: 700 });
      expect(result.ok).toBe(true); expect(navigation).toHaveBeenCalledOnce();
      expect((navigation.mock.calls[0][0] as CustomEvent).detail).toEqual({ url, scopeKey: scope });
    } finally { window.removeEventListener('o8:open-browser', navigation); }
  });

  it('never treats the proxy URL of a complete connection-error document as the actual target page', async () => {
    fixture.nativeEnabled = false; await mount();
    let pending: ReturnType<typeof handler>;
    await act(async () => { pending = handler({ url, timeoutMs: 700 }); });
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-o8-browser="panel"]')!;
    expect(new URL(frame.contentWindow!.location.href).pathname).toBe('/api/browser/proxy');
    const page = frame.contentDocument!;
    page.open(); page.write('<!doctype html><body><p>The local server could not be reached.</p></body>'); page.close();
    Object.defineProperty(page, 'readyState', { value: 'complete', configurable: true });
    const result = await pending!;
    const receipt = JSON.parse((result.content[0] as { text: string }).text);
    expect(receipt).toMatchObject({ ok: false, status: 'unavailable', reason: 'proxy-navigation-unverified', automaticReplay: false });
    expect(receipt.url).toBeUndefined(); expect(fixture.opens).toBe(1);
  });

  it.each(['hidden native window', 'zero child geometry', 'different child URL'] as const)('does not complete for %s', async (failure) => {
    await mount();
    if (failure === 'hidden native window') fixture.nativeVisible = false;
    if (failure === 'zero child geometry') fixture.width = 0;
    if (failure === 'different child URL') { fixture.autoNavigate = false; fixture.url = 'http://localhost:48234/old'; }
    const first = await request({ url, timeoutMs: 0 });
    const observed = await request({ requestId: first.requestId, timeoutMs: 0 });
    expect(observed).toMatchObject({ ok: false, status: 'pending', requestId: first.requestId, automaticReplay: false });
    expect(fixture.opens).toBe(1);
  });

  it('never reopens an unknown request identifier', async () => {
    await mount();
    const result = await request({ requestId: 'previous-unknown-request', timeoutMs: 0 });
    expect(result).toMatchObject({ ok: false, status: 'unavailable', reason: 'request-not-found', automaticReplay: false });
    expect(fixture.opens).toBe(0); expect(getBrowserPaneTabs(scope)).toHaveLength(0);
  });

  it('keeps an already-acknowledged request from reopening a now-hidden native window', async () => {
    await mount(); const first = await request({ url, timeoutMs: 700 });
    fixture.nativeVisible = false;
    const result = await request({ requestId: first.requestId, timeoutMs: 0 });
    expect(result).toMatchObject({ ok: false, status: 'pending' }); expect(fixture.opens).toBe(1);
  });

  it('deduplicates the same dispatch expression if the transport repeats it', async () => {
    await mount(); fixture.replayDispatch = true;
    const result = await request({ url, timeoutMs: 700 });
    expect(result).toMatchObject({ ok: true, status: 'opened' });
    expect(fixture.opens).toBe(1); expect(getBrowserPaneTabs(scope)).toHaveLength(1);
  });

  it('does not accept another workspace scope as the original Browser host', async () => {
    await mount(); const first = await request({ url, timeoutMs: 700 });
    scope = `${scope}-other-workspace`;
    await act(async () => root!.render(createElement(Host)));
    const observed = await request({ requestId: first.requestId, timeoutMs: 0 });
    expect(observed).toMatchObject({ ok: false, status: 'pending', reason: 'browser-not-visible' });
    expect(fixture.opens).toBe(1);
  });

  it('reports a failed host without replaying its callback', async () => {
    await mount(); fixture.hostFails = true;
    const first = await request({ url, timeoutMs: 700 });
    expect(first).toMatchObject({ ok: false, status: 'failed', error: 'Browser host failed' });
    const observed = await request({ requestId: first.requestId, timeoutMs: 0 });
    expect(observed.status).toBe('failed'); expect(fixture.opens).toBe(1);
  });

  it('can reveal the empty Browser without claiming a child navigation', async () => {
    await mount(); const result = await request({ timeoutMs: 700 });
    expect(result).toMatchObject({ ok: true, status: 'opened', navigation: 'not-requested' });
    expect(result.childGeometry).toBeUndefined(); expect(getBrowserPaneTabs(scope)).toHaveLength(0);
  });

  it.each([{ requestId: '' }, { requestId: 4 }, { requestId: 'old', url }, { url: false }, { url: 'javascript:alert(1)' }, { timeoutMs: -1 }, { timeoutMs: 10001 }, { timeoutMs: '100' }])('refuses invalid requests before opening: %j', async (args) => {
    await mount(); const result = await request(args);
    expect(result.ok).toBe(false); expect(fixture.opens).toBe(0);
  });

  it('bounds a missing transport acknowledgement and leaves no observation timers', async () => {
    vi.useFakeTimers();
    try {
      const blocked = { evalJs: async () => new Promise(() => {}), listWindows: async () => ({ windows: [] }) } as unknown as O8WebviewClient;
      const running = createO8WebviewToolHandlers(() => blocked).o8_view_open_browser({ url, timeoutMs: 20 });
      await vi.advanceTimersByTimeAsync(22);
      const result = JSON.parse(((await running).content[0] as { text: string }).text);
      expect(result).toMatchObject({ ok: false, status: 'pending', automaticReplay: false });
      expect(result.requestId).toBeTypeOf('string'); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
