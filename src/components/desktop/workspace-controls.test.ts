// @vitest-environment jsdom
import { act, createElement, type ReactNode, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingDialog } from './FloatingDialog';
import { BrowserPipCard } from './BrowserPipCard';
import { DesktopSignInDialog } from '../auth/DesktopSignInDialog';
import { ServiceTierPicker } from './thoughts/composer-selector/ServiceTierPicker';
import { readComposerServiceTier, writeComposerServiceTier } from './thoughts/composer-selector/service-tier-store';
import { prepareOrchestratorTurn } from './thoughts/use-orchestrator-stream/turn-option-resolution';

const fixture = vi.hoisted(() => ({ activeId: 'second', signIn: vi.fn(async () => {}), tabs: [
  { id: 'first', title: 'First page', host: 'example.com', url: 'https://example.com/first' },
  { id: 'second', title: 'Second page', host: 'example.com', url: 'https://example.com/second' },
] }));
vi.mock('framer-motion', () => ({ AnimatePresence: ({ children }: { children: ReactNode }) => children, motion: { div: 'div' }, useReducedMotion: () => true }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: true, surface: 'glass', paletteId: 'dark' }) }));
vi.mock('./use-o8-browser-tabs', () => ({ useO8BrowserTabs: () => fixture.tabs }));
vi.mock('@/lib/browser/pane-state', () => ({ readBrowserPaneState: () => ({ activeTabId: fixture.activeId }) }));
vi.mock('@/lib/operator/use-native-browser-view', () => ({ useNativeBrowserViewFlag: () => false }));
vi.mock('@/lib/auth/start-desktop-sign-in', () => ({ startDesktopSignIn: fixture.signIn }));
vi.mock('./O8EnginePane', () => ({ O8EnginePane: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('workspace controls through their UI entry points', () => {
  let host: HTMLDivElement; let root: Root;
  beforeEach(() => { localStorage.clear(); fixture.signIn.mockReset().mockResolvedValue(undefined); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); });
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it('contains keyboard focus, dismisses with Escape and restores the launcher', () => {
    const launcher = document.createElement('button'); document.body.append(launcher); launcher.focus();
    const close = vi.fn();
    const dialogProps = { title: 'Test dialog', onClose: close, children: createElement('div', null, createElement('button', null, 'First'), createElement('button', null, 'Last')) };
    act(() => root.render(createElement(FloatingDialog, dialogProps)));
    const buttons = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button');
    expect(document.activeElement).toBe(buttons[0]);
    buttons[1].focus(); act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })));
    expect(document.activeElement).toBe(buttons[0]);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })));
    expect(close).toHaveBeenCalledOnce(); act(() => root.render(null)); expect(document.activeElement).toBe(launcher); launcher.remove();
  });

  it('opens only the existing sign-in handoff and prevents duplicate launches', async () => {
    let release!: () => void; fixture.signIn.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    act(() => root.render(createElement(DesktopSignInDialog, { onClose: vi.fn() })));
    const continueButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((node) => node.textContent === 'Continue in browser')!;
    act(() => { continueButton.click(); continueButton.click(); });
    expect(fixture.signIn).toHaveBeenCalledOnce(); expect(continueButton.disabled).toBe(true);
    await act(async () => { release(); });
    expect(continueButton.disabled).toBe(false); expect(document.body.textContent).toContain('Waiting for sign-in');
  });

  it('automatically opens the active browser page on panel close and restores the selected URL', () => {
    const open = vi.fn();
    const render = (panelVisible: boolean, scopeKey = 'right-panel:repo') => act(() => root.render(createElement(BrowserPipCard, { scopeKey, active: !panelVisible, panelVisible, browserVisible: panelVisible, onOpenBrowser: open })));
    render(true); expect(host.querySelector('[data-hover-pip]')).toBeNull(); render(false);
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/second');
    act(() => button('Previous browser preview')?.click());
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/first');
    act(() => button('Open in Browser tab')?.click()); expect(open).toHaveBeenCalledWith('https://example.com/first');
  });

  it('does not auto-open for a panel that never showed a browser or inherit another repository preview', async () => {
    act(() => root.render(createElement(BrowserPipCard, { scopeKey: 'one', active: false, panelVisible: true })));
    act(() => root.render(createElement(BrowserPipCard, { scopeKey: 'one', active: true, panelVisible: false })));
    expect(host.querySelector('[data-hover-pip]')).toBeNull();
    act(() => window.dispatchEvent(new CustomEvent('o8:browser-pip', { detail: { open: true } })));
    expect(host.querySelector('[data-hover-pip]')).not.toBeNull();
    await act(async () => root.render(createElement(BrowserPipCard, { scopeKey: 'two', active: true })));
    expect(host.querySelector('[data-hover-pip]')).toBeNull();
  });

  it('persists an explicit speed per model and carries it into the next composer turn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ options: [{ id: 'default', label: 'Standard' }, { id: 'priority', label: 'Fast' }, { id: 'ultrafast', label: 'Ultra-fast' }] }) })));
    await act(async () => root.render(createElement(ServiceTierPicker, { backend: 'codex', model: 'test-model', disabled: false })));
    const radios = host.querySelectorAll<HTMLButtonElement>('[role="radio"]'); expect(radios).toHaveLength(3);
    act(() => radios[1].click()); expect(readComposerServiceTier('codex', 'test-model')).toBe('priority');
    expect(prepareOrchestratorTurn('hello', { backend: 'codex', model: 'test-model' }).serviceTier).toBe('priority');
    expect(prepareOrchestratorTurn('hello', { backend: 'codex', model: 'other-model' }).serviceTier).toBeUndefined();
    act(() => root.render(null));
    await act(async () => root.render(createElement(ServiceTierPicker, { backend: 'codex', model: 'test-model', disabled: false })));
    expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Fast');
  });

  it('keeps an unavailable saved choice changeable by keyboard without silently charging a different tier', async () => {
    writeComposerServiceTier('codex', 'test-model', 'ultrafast');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ options: [{ id: 'default', label: 'Standard' }] }) })));
    await act(async () => root.render(createElement(ServiceTierPicker, { backend: 'codex', model: 'test-model', disabled: false })));
    const standard = host.querySelector<HTMLButtonElement>('[role="radio"]')!;
    expect(standard.tabIndex).toBe(0); expect(host.textContent).toContain('no longer available');
    act(() => standard.click()); expect(readComposerServiceTier('codex', 'test-model')).toBe('default');
  });
});
