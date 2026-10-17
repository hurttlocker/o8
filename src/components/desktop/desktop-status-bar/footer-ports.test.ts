// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FooterPorts } from './footer-ports';
vi.mock('../hooks/DesktopWebSocketContext', () => ({ useWsConnectionState: () => 'connected' }));
vi.mock('@/lib/panel/fetch-cache', () => ({ fetchOnce: async () => Response.json({ ports: [{ port: 8765, label: 'Preview page', kind: 'page', process: 'node', repo: 'site' }] }) }));
vi.mock('@/lib/panel/durable-refresh', () => ({ startDurableRefresh: () => () => {}, REALTIME_FALLBACK_REFRESH_MS: 60000 }));
vi.mock('@/lib/util/webview-safe', () => ({ safeRequestIdleCallback: (callback: () => void) => { void Promise.resolve().then(callback); return 1; }, safeCancelIdleCallback: () => {} }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: true, surface: 'glass', paletteId: 'dark' }) }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('opens above its parent tool card and keeps the child reachable until Escape', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const preview = vi.fn();
  try {
    await act(async () => root.render(createElement(FooterPorts, { placement: 'above', onPortPreview: preview,
      renderTrigger: () => createElement('button', null, 'Ports') })));
    const anchor = host.querySelector<HTMLElement>('[data-footer-ports]')!;
    anchor.getBoundingClientRect = () => ({ top: 240, bottom: 264, left: 700, right: 760, width: 60, height: 24 } as DOMRect);
    await act(async () => anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    const panel = document.querySelector<HTMLElement>('[data-ports-popover]')!;
    expect(panel).not.toBeNull(); expect(Number(panel.style.zIndex)).toBeGreaterThan(10000);
    expect(Number.parseFloat(panel.style.bottom)).toBeGreaterThan(window.innerHeight - 240);
    expect(panel.style.backdropFilter).toContain('blur(24px)');
    await act(async () => { anchor.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); panel.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); vi.advanceTimersByTime(250); });
    expect(document.querySelector('[data-ports-popover]')).toBe(panel);
    await act(async () => panel.querySelector<HTMLButtonElement>('button')!.click());
    expect(preview).toHaveBeenCalledExactlyOnceWith(8765, 'http://localhost:8765', 'site');
    await act(async () => anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[data-ports-popover]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
