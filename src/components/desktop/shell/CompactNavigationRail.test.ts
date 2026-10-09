// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompactNavigationRail } from './CompactNavigationRail';
import { OPEN_KEYBOARD_SHORTCUTS_EVENT, OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';
import { setCustomizeTab } from '../customize/navigation';
import { refreshCliUpdateView } from '@/lib/app-update/update-hub-client';

const auth = vi.hoisted(() => ({ signedIn: false, clerkEnabled: true, user: { name: 'Private account', email: 'private@example.test' }, signIn: vi.fn(), openManageAccount: vi.fn() }));
const updateCheck = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => auth }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ paletteId: 'light', workspaceGlass: false }) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));
vi.mock('@/lib/app-update/check', () => ({ check: updateCheck }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
beforeEach(() => {
  setCustomizeTab('rules');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/setup/cli-updates')) return Response.json({ tools: [] });
    if (String(input).startsWith('/api/panel/o8-update-summary')) return Response.json({ version: '0.1.1', summary: 'Published changes', entries: [{ text: 'Clearer navigation' }], source: 'release', releaseUrl: 'https://github.com/hurttlocker/o8-releases/releases/tag/v0.1.1' });
    throw new Error(`Unexpected request ${String(input)}`);
  }));
});
afterEach(() => { auth.signedIn = false; vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('keeps navigation usable with the chat list open or closed and reads fresh usage', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const callbacks = {
    onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(),
    onOpenProjects: vi.fn(), onOpenSettings: vi.fn(),
    onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn(),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/runtime/capacity') return Response.json({
      schema: 'o8/runtime-capacity-control/v1', capacities: [{ runtime: 'codex', status: 'available', confidence: 'exact', buckets: [{ id: 'weekly', label: 'Weekly', usedRatio: 0.4 }] }],
    });
    if (String(input).startsWith('/api/setup/cli-updates')) return Response.json({ tools: [] });
    if (String(input).startsWith('/api/panel/o8-update-summary')) return Response.json({ version: '0.1.1', summary: 'Published changes', entries: [{ text: 'Clearer navigation' }], source: 'release' });
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
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'projects', glassSurface: false })));
    expect(fetch).not.toHaveBeenCalledWith('/api/runtime/capacity', expect.anything());
    expect(host.querySelector('[aria-label="Search"]')).toBeNull();
    expect(host.querySelector('[aria-label="Projects"]')).toBeNull();
    expect(host.querySelector('[aria-label="Customize"]')).toBeNull();
    expect(button('More navigation').getAttribute('aria-current')).toBe('page');
    expect(button('Automations')).toBeDefined();
    expect(button('Plugins')).toBeDefined();
    await act(async () => button('More navigation').click());
    const projects = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="Projects"]')!;
    expect(projects.getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(projects);
    await act(async () => projects.click());
    expect(callbacks.onOpenProjects).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-label="More destinations"]')).toBeNull();
    expect(document.activeElement).toBe(button('More navigation'));
    expect(host.querySelector('[aria-label="Hide chats"], [aria-label="Show chats"], [aria-label="Settings"]')).toBeNull();
    expect(button('Canvas mode')).toBeDefined();
    for (const [label, callback] of [['Home', callbacks.onHome], ['Run orchestrator', callbacks.onNewSession], ['Run terminal', callbacks.onCreateTerminal], ['PRs', callbacks.onOpenPRs]] as const) {
      await act(async () => button(label).click());
      expect(callback).toHaveBeenCalledOnce();
      expect(button(label).style.minWidth).toBe('44px');
      expect(button(label).style.minHeight).toBe('44px');
    }
    expect(button('More navigation').nextElementSibling).toBe(button('PRs'));
    expect(button('More navigation').style.minWidth).toBe('44px');
    expect(button('More navigation').style.minHeight).toBe('44px');
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
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: true })));
    expect(host.querySelector('[aria-label="Workspace navigation"]')).toBe(rail);
    expect(host.querySelector('[aria-label="Hide chats"], [aria-label="Show chats"]')).toBeNull();
    expect(button('Home').getAttribute('aria-current')).toBe('page');
    expect((rail as HTMLElement).style.background).toBe('transparent');
    expect((rail as HTMLElement).style.boxShadow).toBe('none');
    expect(fetch).toHaveBeenCalledWith('/api/runtime/capacity', expect.objectContaining({ cache: 'no-store' }));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('reaches Plugins directly, keeps Automations, and navigates the secondary drawer by keyboard', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  const customize = vi.fn();
  const automations = vi.fn();
  window.addEventListener('o8:open-customize', customize);
  window.addEventListener('o8:open-automations', automations);
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const key = async (value: string) => act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: true })));
    await act(async () => button('Automations').click());
    expect(automations).toHaveBeenCalledOnce();
    await act(async () => button('Plugins').click());
    expect(customize).toHaveBeenCalledOnce();
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'customize', glassSurface: true })));
    expect(button('Plugins').getAttribute('aria-current')).toBe('page');
    await act(async () => button('More navigation').click());
    expect(document.activeElement).toBe(button('Projects'));
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    await key('ArrowDown');
    expect(document.activeElement).toBe(button('Customize'));
    await key('Escape');
    expect(document.querySelector('[aria-label="More destinations"]')).toBeNull();
    expect(document.activeElement).toBe(button('More navigation'));
    await act(async () => button('More navigation').click());
    await key('End');
    await act(async () => button('Customize').click());
    expect(customize).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[aria-label="More destinations"]')).toBeNull();
    await act(async () => button('More navigation').click());
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(document.querySelector('[aria-label="More destinations"]')).toBeNull();
  } finally {
    window.removeEventListener('o8:open-customize', customize);
    window.removeEventListener('o8:open-automations', automations);
    await act(async () => root.unmount());
    host.remove();
  }
});

it('opens cached release notes from the updater and restores focus on Escape without reopening', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  const install = vi.fn();
  window.addEventListener('o8:install-all-updates', install);
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: false })));
    const updates = host.querySelector<HTMLButtonElement>('[aria-label="Updates"]')!;
    await act(async () => updates.click());
    const popup = document.querySelector<HTMLElement>('[aria-label="Updates and release notes"]')!;
    expect(popup.textContent).toContain('Clearer navigation');
    expect(popup.id).toBe(updates.getAttribute('aria-controls'));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Refresh updates');
    expect(document.querySelector('[aria-label="Quick settings"]')).toBeNull();
    expect(updateCheck).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.querySelector('[aria-label="Updates and release notes"]')).toBeNull();
    expect(document.activeElement).toBe(updates);
    expect(updates.getAttribute('aria-expanded')).toBe('false');
  } finally {
    window.removeEventListener('o8:install-all-updates', install);
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
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  const settings = vi.fn();
  const help = vi.fn();
  window.addEventListener(OPEN_SETTINGS_TAB_EVENT, settings);
  window.addEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, help);
  const drawer = () => document.querySelector<HTMLElement>('[aria-label="Quick settings"]');
  const menuButton = (label: string) => [...drawer()!.querySelectorAll('button')].find((button) => button.textContent?.startsWith(label))!;
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: false })));
    const avatar = host.querySelector<HTMLButtonElement>('[aria-label="Open quick settings"]')!;
    await act(async () => avatar.click());
    expect(drawer()?.id).toBe(avatar.getAttribute('aria-controls'));
    expect(document.activeElement).toBe(menuButton('Account'));
    expect(drawer()?.textContent).not.toMatch(/private@example|Private account|Sign out|Sign in/);
    expect(drawer()?.textContent).not.toContain('Runtime capacity');
    expect(drawer()?.textContent).not.toContain('Check for updates');
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

it('shows only installed supported CLIs and keeps legacy Gemini out of the update dot', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const tools = [{ runtimeId: 'codex', label: 'Codex CLI', status: 'not-installed' },
    { runtimeId: 'claude-code', label: 'Claude Code', status: 'current' },
    { runtimeId: 'grok', label: 'Grok Build', status: 'current' },
    { runtimeId: 'gemini', label: 'Gemini CLI', status: 'update-available' }];
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/setup/cli-updates')) return Response.json({ tools });
    return Response.json({ entries: [], summary: 'Published changes' });
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: true })));
    await act(async () => refreshCliUpdateView(true));
    expect(host.querySelector('[data-update-dot]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Updates"]')!.click());
    const popup = document.querySelector('[aria-label="Updates and release notes"]')!;
    expect(popup.textContent).toContain('Grok Build'); expect(popup.textContent).toContain('Claude Code');
    expect(popup.textContent).not.toContain('Codex CLI'); expect(popup.textContent).not.toContain('Gemini CLI');
    tools[2]!.status = 'update-available';
    await act(async () => refreshCliUpdateView(true));
    expect(host.querySelector('[data-update-dot]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
