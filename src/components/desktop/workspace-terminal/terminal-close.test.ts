// @vitest-environment jsdom
import { act, createElement, Fragment, useEffect, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCloseDialog } from './TerminalCloseDialog';
import { useWorkspaceTabCleanup } from './useWorkspaceTabCleanup';
import { confirmTerminalClose } from './terminal-close-confirm';
import type { TerminalTab } from './types';
vi.mock('framer-motion', () => ({ motion: { div: 'div' }, useReducedMotion: () => true }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: true, surface: 'glass', paletteId: 'dark' }) }));
vi.mock('./terminal-tab-handlers', async (original) => ({ ...await original<typeof import('./terminal-tab-handlers')>(), archivePacket: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe('terminal close through the workspace tab handler', () => {
  let root: Root; let host: HTMLDivElement; let cleanup: ReturnType<typeof useWorkspaceTabCleanup>;
  let options: Parameters<typeof useWorkspaceTabCleanup>[0];
  const terminal: TerminalTab = { id: 'own-terminal', label: 'Test terminal', kind: 'terminal', tmuxSession: 'own-session', createdAt: 1, lastActivity: 1 };
  function Controller({ value }: { value: typeof options }) {
    const current = useWorkspaceTabCleanup(value);
    useEffect(() => { cleanup = current; }, [current]);
    return null;
  }
  function Harness({ controllerKey = 'original', controllerOptions = options }: { controllerKey?: string; controllerOptions?: typeof options }) {
    return createElement(Fragment, null,
      createElement(Controller, { key: controllerKey, value: controllerOptions }),
      createElement(TerminalCloseDialog));
  }
  beforeEach(() => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    options = { activeTabId: terminal.id, effectiveActiveTabId: terminal.id, tabs: [terminal], tabsRef: { current: [terminal] }, panelRefs: { current: new Map() }, pendingCliCommands: { current: new Map() }, pendingRequestRef: { current: new Map() }, pendingSessionsRef: { current: new Set() }, detectedPortsRef: { current: new Set() }, sendTerminalDetach: vi.fn(), sendTerminalInput: vi.fn(), setActiveTabIdFromUser: vi.fn(), setTabs: vi.fn(), setPreviews: vi.fn() };
    act(() => root.render(createElement(Harness)));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); });
  const click = async (text: string) => { await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((node) => node.textContent === text)?.click()); };
  it('does not detach anything on cancel, then detaches only the confirmed terminal', async () => {
    act(() => cleanup.handleCloseTab(terminal.id)); expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(options.sendTerminalDetach).not.toHaveBeenCalled(); await click('Keep terminal'); expect(options.tabsRef.current).toHaveLength(1);
    act(() => cleanup.handleCloseTab(terminal.id)); await click('Close terminal');
    expect(options.sendTerminalDetach).toHaveBeenCalledWith('own-session'); expect(options.tabsRef.current).toHaveLength(0);
  });
  it('cancels on Escape and on unmount without losing the terminal', async () => {
    act(() => cleanup.handleCloseTab(terminal.id));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(options.sendTerminalDetach).not.toHaveBeenCalled();
    act(() => cleanup.handleCloseTab(terminal.id)); await act(async () => root.render(null));
    expect(options.sendTerminalDetach).not.toHaveBeenCalled(); expect(await confirmTerminalClose(terminal)).toBe(false);
  });
  it('does not close a replaced session after a stale confirmation', async () => {
    act(() => cleanup.handleCloseTab(terminal.id)); options.tabsRef.current = [{ ...terminal, tmuxSession: 'replacement-session' }];
    await click('Close terminal'); expect(options.sendTerminalDetach).not.toHaveBeenCalled();
  });
  it('does not detach or clear replacement workspace state after the requesting controller unmounts', async () => {
    act(() => cleanup.handleCloseTab(terminal.id));
    const replacementOptions = {
      ...options,
      tabsRef: { current: [{ ...terminal }] },
      sendTerminalDetach: vi.fn(),
      setTabs: vi.fn(),
      setActiveTabIdFromUser: vi.fn(),
      setPreviews: vi.fn(),
    };
    act(() => root.render(createElement(Harness, { controllerKey: 'replacement', controllerOptions: replacementOptions })));
    const storageKey = `o8:orchestrator:session-tiles:tab:${terminal.id}`;
    localStorage.setItem(storageKey, 'replacement workspace tiles');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await click('Close terminal');
    expect(options.sendTerminalDetach).not.toHaveBeenCalled();
    expect(options.setTabs).not.toHaveBeenCalled();
    expect(replacementOptions.sendTerminalDetach).not.toHaveBeenCalled();
    expect(replacementOptions.setTabs).not.toHaveBeenCalled();
    expect(replacementOptions.tabsRef.current).toEqual([terminal]);
    expect(localStorage.getItem(storageKey)).toBe('replacement workspace tiles');
  });
  it('closes chat views immediately while preserving confirmation for interactive terminals', () => {
    options.tabsRef.current = [{ ...terminal, kind: 'orchestrator' }];
    act(() => cleanup.handleCloseTab(terminal.id)); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(options.sendTerminalDetach).toHaveBeenCalledOnce();
  });
});
