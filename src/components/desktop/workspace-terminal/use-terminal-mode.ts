'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RegisteredRepo, TerminalTab } from '@/components/desktop/workspace-terminal/types';
import {
  captureTerminalModeSnapshot,
  resolveTerminalModeEntry,
  resolveTerminalModeReturnTab,
  restoreTerminalModeFocus,
  setWorkspaceTerminalMode,
  type TerminalModesByWorkspace,
  type WorkspaceAttachedTerminalSession,
} from '@/components/desktop/workspace-terminal/terminal-mode';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { TERMINAL_MODE_TOGGLE_EVENT } from '@/components/desktop/shell/TerminalModePill';

export function useTerminalMode({
  activeTab,
  activeTabId,
  attachedSessions,
  canCloseTile,
  createShellTab,
  attachTerminalSession,
  panelRefs,
  preferredRepo,
  selectTab,
  tabs,
  workspaceActive,
  workspaceId,
}: {
  activeTab: TerminalTab | null;
  activeTabId: string;
  attachedSessions: WorkspaceAttachedTerminalSession[];
  canCloseTile: boolean;
  createShellTab: (repo?: RegisteredRepo) => string;
  attachTerminalSession: (session: WorkspaceAttachedTerminalSession, repo: RegisteredRepo | null) => string;
  panelRefs: React.MutableRefObject<Map<string, XtermPanelHandle>>;
  preferredRepo: RegisteredRepo | null;
  selectTab: (tabId: string) => void;
  tabs: TerminalTab[];
  workspaceActive: boolean;
  workspaceId: string;
}) {
  const [modes, setModes] = useState<TerminalModesByWorkspace>(() => new Map());
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const mode = modes.get(workspaceId) ?? null;

  const exit = useCallback(() => {
    const current = modes.get(workspaceId);
    if (!current) return;
    const restored = resolveTerminalModeReturnTab(current.snapshot, tabsRef.current);
    if (restored.tabId) selectTab(restored.tabId);
    if (restored.substituted) {
      console.info('[terminal-mode] return tab closed; restored the deterministic surviving tab');
    }
    setModes((previous) => setWorkspaceTerminalMode(previous, workspaceId, null));
    window.requestAnimationFrame(() => restoreTerminalModeFocus(current.snapshot));
  }, [modes, selectTab, workspaceId]);

  const enter = useCallback(() => {
    const resolution = resolveTerminalModeEntry({ activeTab, attachedSessions, preferredRepo, tabs: tabsRef.current });
    let terminalTabId: string;
    let tmuxSession: string | null;
    if (resolution.kind === 'attached-session') {
      terminalTabId = attachTerminalSession(resolution.session, resolution.repo);
      tmuxSession = resolution.session.tmuxSession;
    } else if (resolution.kind === 'existing-terminal') {
      terminalTabId = resolution.tabId;
      tmuxSession = resolution.tmuxSession;
    } else {
      terminalTabId = createShellTab(resolution.repo ?? undefined);
      tmuxSession = null;
    }
    if (!terminalTabId) return;
    const snapshot = captureTerminalModeSnapshot(workspaceId, activeTabId, document.activeElement);
    setModes((previous) => setWorkspaceTerminalMode(previous, workspaceId, {
      terminalTabId,
      tmuxSession,
      snapshot,
    }));
  }, [activeTab, activeTabId, attachTerminalSession, attachedSessions, createShellTab, preferredRepo, workspaceId]);

  const toggle = useCallback(() => {
    if (modes.has(workspaceId)) exit();
    else enter();
  }, [enter, exit, modes, workspaceId]);

  useEffect(() => {
    const onToggle = (event: Event) => {
      const eventWorkspaceId = (event as CustomEvent<{ workspaceId?: string | null }>).detail?.workspaceId;
      if (eventWorkspaceId ? eventWorkspaceId !== workspaceId : (!workspaceActive && canCloseTile)) return;
      toggle();
    };
    window.addEventListener(TERMINAL_MODE_TOGGLE_EVENT, onToggle as EventListener);
    return () => window.removeEventListener(TERMINAL_MODE_TOGGLE_EVENT, onToggle as EventListener);
  }, [canCloseTile, toggle, workspaceActive, workspaceId]);

  const terminalTab = useMemo(
    () => mode ? tabs.find((tab) => tab.id === mode.terminalTabId) ?? null : null,
    [mode, tabs],
  );
  const terminalSession = terminalTab?.tmuxSession ?? mode?.tmuxSession ?? null;
  useEffect(() => {
    if (!mode || !terminalSession) return;
    const frame = window.requestAnimationFrame(() => panelRefs.current.get(terminalSession)?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mode, panelRefs, terminalSession]);

  useEffect(() => {
    if (!mode || terminalTab) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) exit();
    });
    return () => {
      cancelled = true;
    };
  }, [exit, mode, terminalTab]);

  return {
    active: Boolean(mode),
    effectiveActiveTabId: mode?.terminalTabId ?? activeTabId,
    terminalTab,
    toggle,
  };
}
