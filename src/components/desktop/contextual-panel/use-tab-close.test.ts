// @vitest-environment jsdom
import { act, createElement, useEffect, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextualTabClose } from './use-tab-close';
import { TerminalCloseDialog } from '../workspace-terminal/TerminalCloseDialog';
import type { ContextualPanelTab } from '../ContextualPanel';

vi.mock('framer-motion', () => ({ motion: { div: 'div' }, useReducedMotion: () => true }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: true, surface: 'glass', paletteId: 'dark' }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('contextual terminal close confirmation', () => {
  let root: Root; let host: HTMLDivElement; let controls: ReturnType<typeof useContextualTabClose>;
  let options: Parameters<typeof useContextualTabClose>[0];
  const tab: ContextualPanelTab = { id: 'one', label: 'Shell', kind: 'terminal', agentId: 'shell', tmuxSession: 'one-session', createdAt: 1, lastActivity: 1 };
  function Harness() { const current = useContextualTabClose(options); useEffect(() => { controls = current; }, [current]); return createElement(TerminalCloseDialog); }
  beforeEach(() => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    options = { tabsRef: { current: [tab, { ...tab, id: 'two', tmuxSession: 'two-session' }] }, activeTabId: 'one', setTabs: vi.fn(), setActiveTabId: vi.fn(), sendTerminalDetach: vi.fn(), xtermRefs: { current: new Map() }, pendingTabIdsRef: { current: [] }, pendingAgentsRef: { current: new Map() }, pendingCommandsRef: { current: new Map() }, pendingRequestRef: { current: new Map() }, createShell: vi.fn(), termWsConnected: true };
    act(() => root.render(createElement(Harness)));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const click = async (label: string) => { await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === label)?.click()); };

  it('preserves the side terminal on cancel and detaches only the confirmed view', async () => {
    act(() => controls.closeTab('one')); await click('Keep terminal');
    expect(options.sendTerminalDetach).not.toHaveBeenCalled(); expect(options.tabsRef.current).toHaveLength(2);
    act(() => controls.closeTab('one')); await click('Close terminal');
    expect(options.sendTerminalDetach).toHaveBeenCalledWith('one-session'); expect(options.tabsRef.current.map((entry) => entry.id)).toEqual(['two']);
    expect(options.setActiveTabId).toHaveBeenCalledWith('two');
  });
  it('requires a fresh confirmation for the whole panel and refuses a replaced session', async () => {
    let result!: Promise<boolean>;
    act(() => { result = controls.confirmPanelClose(); });
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Close 2 terminals?');
    await click('Keep terminals'); expect(await result).toBe(false);
    act(() => { result = controls.confirmPanelClose(); });
    options.tabsRef.current = [{ ...tab, tmuxSession: 'replacement' }, options.tabsRef.current[1]];
    await click('Close terminals'); expect(await result).toBe(false); expect(options.sendTerminalDetach).not.toHaveBeenCalled();
    act(() => { result = controls.confirmPanelClose(); });
    await click('Close terminals'); expect(await result).toBe(true);
  });
  it('closes read-only agent views immediately and never closes an unmounted interactive view', async () => {
    options.tabsRef.current = [{ ...tab, readOnly: true }];
    act(() => controls.closeTab('one')); expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(options.sendTerminalDetach).toHaveBeenCalledWith('one-session');
    options.sendTerminalDetach = vi.fn(); options.tabsRef.current = [tab];
    act(() => controls.closeTab('one')); await act(async () => root.render(null));
    expect(options.sendTerminalDetach).not.toHaveBeenCalled();
  });
});
