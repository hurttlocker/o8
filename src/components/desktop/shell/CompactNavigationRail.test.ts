// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompactNavigationRail } from './CompactNavigationRail';
import { OPEN_KEYBOARD_SHORTCUTS_EVENT, OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';

const auth = vi.hoisted(() => ({ signedIn: false, clerkEnabled: true, user: { name: 'Private account', email: 'private@example.test' }, signIn: vi.fn(), openManageAccount: vi.fn() }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => auth }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ paletteId: 'light', workspaceGlass: false }) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
afterEach(() => { auth.signedIn = false; vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('keeps navigation usable with the chat list open or closed and reads fresh usage', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const callbacks = {
    onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(),
    onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onToggleSidebar: vi.fn(),
    onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn(),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/runtime/capacity') return Response.json({
      schema: 'o8/runtime-capacity-control/v1', capacities: [{ runtime: 'codex', status: 'available', confidence: 'exact', buckets: [{ id: 'weekly', label: 'Weekly', usedRatio: 0.4 }] }],
    });
    throw new Error(`Unexpected request ${String(input)}`);
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) => {
    const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(found).not.toBeNull();
    return found!;
  };
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, sidebarVisible: true, activeDestination: 'projects', glassSurface: false })));
    expect(fetch).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Search"]')).toBeNull();
    expect(button('Projects').getAttribute('aria-current')).toBe('page');
    expect(button('Hide chats').getAttribute('aria-expanded')).toBe('true');
    expect(button('Hide chats').getAttribute('aria-controls')).toBe('o8-chat-list');
    for (const [label, callback] of [['Home', callbacks.onHome], ['New session', callbacks.onNewSession], ['Terminal', callbacks.onCreateTerminal], ['Projects', callbacks.onOpenProjects], ['PRs', callbacks.onOpenPRs], ['Settings', callbacks.onOpenSettings], ['Hide chats', callbacks.onToggleSidebar]] as const) {
      await act(async () => button(label).click());
      expect(callback).toHaveBeenCalledOnce();
      expect(button(label).style.minWidth).toBe('44px');
      expect(button(label).style.minHeight).toBe('44px');
    }
    expect(button('Projects').nextElementSibling).toBe(button('PRs'));
    expect(host.querySelector('[aria-label="Handoffs"]')).toBeNull();
    await act(async () => button('Runtime usage').focus());
    expect(document.getElementById('o8-rail-usage-tooltip')?.textContent).toContain('40% used');
    await act(async () => button('Runtime usage').click());
    expect(callbacks.onOpenUsage).toHaveBeenCalledOnce();
    await act(async () => { button('Runtime usage').blur(); button('Runtime usage').focus(); });
    for (const scroller of host.querySelectorAll<HTMLElement>('[style*="overflow-y: auto"]')) expect(scroller.style.scrollbarWidth).toBe('none');
    await act(async () => button('Runtime usage').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.getElementById('o8-rail-usage-tooltip')).toBeNull();
    const rail = host.querySelector('[aria-label="Workspace navigation"]');
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, sidebarVisible: false, activeDestination: 'agents', glassSurface: true })));
    expect(host.querySelector('[aria-label="Workspace navigation"]')).toBe(rail);
    expect(button('Show chats').getAttribute('aria-expanded')).toBe('false');
    await act(async () => button('Show chats').click());
    expect(callbacks.onToggleSidebar).toHaveBeenCalledTimes(2);
    expect(button('Home').getAttribute('aria-current')).toBe('page');
    expect((rail as HTMLElement).style.background).toBe('transparent');
    expect((rail as HTMLElement).style.boxShadow).toBe('none');
    expect(fetch).toHaveBeenCalledWith('/api/runtime/capacity', expect.objectContaining({ cache: 'no-store' }));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('opens quick settings from the avatar, keeps account details in Settings, and returns keyboard focus', async () => {
  auth.signedIn = true;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onToggleSidebar: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  const settings = vi.fn();
  const help = vi.fn();
  window.addEventListener(OPEN_SETTINGS_TAB_EVENT, settings);
  window.addEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, help);
  const drawer = () => document.querySelector<HTMLElement>('[aria-label="Quick settings"]');
  const menuButton = (label: string) => [...drawer()!.querySelectorAll('button')].find((button) => button.textContent?.startsWith(label))!;
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, sidebarVisible: true, activeDestination: 'agents', glassSurface: false })));
    const avatar = host.querySelector<HTMLButtonElement>('[aria-label="Open quick settings"]')!;
    await act(async () => avatar.click());
    expect(drawer()?.id).toBe(avatar.getAttribute('aria-controls'));
    expect(document.activeElement).toBe(menuButton('Account'));
    expect(drawer()?.textContent).not.toMatch(/private@example|Private account|Sign out|Sign in/);
    expect(auth.openManageAccount).not.toHaveBeenCalled();
    expect(auth.signIn).not.toHaveBeenCalled();
    const last = [...drawer()!.querySelectorAll('button')].at(-1)!;
    last.focus();
    await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(menuButton('Account'));
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(avatar);
    await act(async () => avatar.click());
    await act(async () => menuButton('Account').click());
    expect(settings.mock.calls[0][0].detail).toEqual({ tab: 'account' });
    expect(drawer()).toBeNull();
    await act(async () => avatar.click());
    await act(async () => menuButton('Get help').click());
    await act(async () => menuButton('?Keyboard shortcuts').click());
    expect(callbacks.onOpenShortcuts).toHaveBeenCalledOnce();
    expect(help).not.toHaveBeenCalled();
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(avatar);
    await act(async () => avatar.click());
    await act(async () => menuButton('Appearance').click());
    expect(settings.mock.calls[1][0].detail).toEqual({ tab: 'appearance' });
    expect(drawer()).toBeNull();
  } finally {
    window.removeEventListener(OPEN_SETTINGS_TAB_EVENT, settings);
    window.removeEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, help);
    await act(async () => root.unmount());
    host.remove();
  }
});
