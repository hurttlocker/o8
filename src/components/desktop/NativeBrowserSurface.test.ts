// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NativeBrowserSurface } from './NativeBrowserSurface';

const bridge = vi.hoisted(() => ({ open: vi.fn(), setRect: vi.fn(), hide: vi.fn(), show: vi.fn(), capture: vi.fn(async () => null) }));
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
