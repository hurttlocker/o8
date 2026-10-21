// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NativeBrowserSurface } from './NativeBrowserSurface';

const bridge = vi.hoisted(() => ({ open: vi.fn(), setRect: vi.fn(), hide: vi.fn(), show: vi.fn(), capture: vi.fn<() => Promise<string | null>>(async () => null) }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true, browserViewOpen: bridge.open, browserViewSetRect: bridge.setRect, browserViewHide: bridge.hide, browserViewShow: bridge.show, browserViewCapture: bridge.capture, browserViewClose: vi.fn() }));

it('moves the native browser page with its floating shell without requiring a resize', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => 'null' })));
  let intersect!: (entries: IntersectionObserverEntry[]) => void;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const pip = this.closest<HTMLElement>('[data-hover-pip]');
    if (this.dataset.o8NativeBrowser && pip) return new DOMRect(Number.parseFloat(pip.style.left), Number.parseFloat(pip.style.top) + 30, 440, 264);
    return new DOMRect();
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    act(() => root.render(createElement('div', { 'data-hover-pip': '', style: { position: 'fixed', left: 100, top: 120 } }, createElement(NativeBrowserSurface, { url: 'https://example.com/' }))));
    act(() => intersect([{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry]));
    expect(bridge.open).toHaveBeenCalledWith('https://example.com/', { x: 100, y: 150, w: 440, h: 264 }, expect.any(String));
    const pip = host.querySelector<HTMLElement>('[data-hover-pip]')!;
    await act(async () => { pip.style.left = '200px'; pip.style.top = '220px'; await Promise.resolve(); });
    expect(bridge.setRect).toHaveBeenLastCalledWith({ x: 200, y: 250, w: 440, h: 264 });
  } finally {
    act(() => root.unmount()); host.remove(); measure.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
  }
});

it.each(['blurred root', 'painted child'])('keeps the native page live beneath a transparent %s portal and still occludes visible overlays', async (variant) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => 'null' })));
  let intersect!: (entries: IntersectionObserverEntry[]) => void;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const portal = document.createElement('div');
  portal.style.opacity = '0';
  portal.style.backdropFilter = variant === 'blurred root' ? 'blur(24px)' : 'none';
  const body = document.createElement('div'); body.style.backgroundColor = 'rgb(38, 38, 38)'; portal.append(body);
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.o8NativeBrowser) return new DOMRect(100, 100, 440, 300);
    if (this === portal || portal.contains(this)) return new DOMRect(120, 120, 200, 100);
    if (this.style.height === '100vh') return new DOMRect(0, 0, 1, window.innerHeight);
    return new DOMRect();
  });
  const originalPoints = document.elementsFromPoint;
  document.elementsFromPoint = vi.fn(() => portal.isConnected ? [body] : [host.querySelector('[data-o8-native-browser]')!]);
  bridge.capture.mockResolvedValue('fixture-snapshot');
  try {
    act(() => root.render(createElement(NativeBrowserSurface, { url: `https://example.com/occlusion-${variant.replaceAll(' ', '-')}` })));
    act(() => intersect([{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry]));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    bridge.hide.mockClear(); bridge.show.mockClear();
    await act(async () => { document.body.append(portal); await vi.advanceTimersByTimeAsync(600); });
    expect(bridge.hide).not.toHaveBeenCalled();
    expect(host.querySelector('img')?.style.display).toBe('none');
    await act(async () => { portal.style.opacity = '1'; await vi.advanceTimersByTimeAsync(600); });
    expect(bridge.hide).toHaveBeenCalledOnce();
    expect(host.querySelector('img')?.style.display).toBe('block');
    await act(async () => { portal.remove(); await vi.advanceTimersByTimeAsync(900); });
    expect(bridge.show).toHaveBeenCalledOnce();
    expect(host.querySelector('img')?.style.display).toBe('none');
    act(() => window.dispatchEvent(new CustomEvent('o8:native-browser-occlude', { detail: { occlude: true } })));
    expect(bridge.hide).toHaveBeenCalledTimes(2);
    act(() => window.dispatchEvent(new CustomEvent('o8:native-browser-occlude', { detail: { occlude: false } })));
    expect(bridge.show).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount()); host.remove(); portal.remove(); measure.mockRestore();
    document.elementsFromPoint = originalPoints;
    bridge.capture.mockResolvedValue(null);
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
  }
});
