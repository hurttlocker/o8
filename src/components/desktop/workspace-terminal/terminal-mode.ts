import type { RegisteredRepo, TerminalTab } from '@/components/desktop/workspace-terminal/types';
import { normalizeWorkspaceChatSessionKey } from '@/components/desktop/workspace-terminal/utils';

export interface WorkspaceAttachedTerminalSession {
  sessionKey: string;
  tmuxSession: string;
  label?: string;
  repo?: RegisteredRepo;
}

export interface TerminalModeSnapshot {
  workspaceId: string;
  activeTabId: string;
  focusTarget: HTMLElement | null;
}

export interface TerminalModePresentation {
  terminalTabId: string;
  tmuxSession: string | null;
  snapshot: TerminalModeSnapshot;
}

export type TerminalModesByWorkspace = ReadonlyMap<string, TerminalModePresentation>;

export type TerminalModeEntryResolution =
  | { kind: 'attached-session'; session: WorkspaceAttachedTerminalSession; repo: RegisteredRepo | null }
  | { kind: 'existing-terminal'; tabId: string; tmuxSession: string | null }
  | { kind: 'new-shell'; repo: RegisteredRepo | null };

export function captureTerminalModeSnapshot(
  workspaceId: string,
  activeTabId: string,
  focusTarget: Element | null,
): TerminalModeSnapshot {
  return {
    workspaceId,
    activeTabId,
    focusTarget: focusTarget instanceof HTMLElement && focusTarget !== document.body
      ? focusTarget
      : null,
  };
}

export function resolveTerminalModeEntry({
  activeTab,
  attachedSessions,
  preferredRepo,
  tabs,
}: {
  activeTab: TerminalTab | null;
  attachedSessions: WorkspaceAttachedTerminalSession[];
  preferredRepo: RegisteredRepo | null;
  tabs: TerminalTab[];
}): TerminalModeEntryResolution {
  const activeSessionKey = activeTab?.kind === 'chat'
    ? normalizeWorkspaceChatSessionKey(activeTab.chatRuntime, activeTab.chatSessionKey)
    : null;
  const attachedSession = activeSessionKey
    ? attachedSessions.find((session) => session.sessionKey === activeSessionKey && session.tmuxSession.trim())
    : null;
  if (attachedSession) {
    const existing = tabs.find((tab) => (
      tab.kind === 'terminal' && tab.tmuxSession === attachedSession.tmuxSession
    ));
    if (existing) {
      return { kind: 'existing-terminal', tabId: existing.id, tmuxSession: existing.tmuxSession };
    }
    return {
      kind: 'attached-session',
      session: attachedSession,
      repo: attachedSession.repo ?? activeTab?.repo ?? preferredRepo,
    };
  }

  const targetRepo = activeTab?.repo ?? preferredRepo;
  const existing = tabs.find((tab) => (
    tab.kind === 'terminal'
    && (targetRepo ? tab.repo?.localPath === targetRepo.localPath : true)
  ));
  if (existing) {
    return { kind: 'existing-terminal', tabId: existing.id, tmuxSession: existing.tmuxSession };
  }
  return { kind: 'new-shell', repo: targetRepo };
}

export function setWorkspaceTerminalMode(
  current: TerminalModesByWorkspace,
  workspaceId: string,
  presentation: TerminalModePresentation | null,
): TerminalModesByWorkspace {
  const next = new Map(current);
  if (presentation) next.set(workspaceId, presentation);
  else next.delete(workspaceId);
  return next;
}

export function resolveTerminalModeReturnTab(
  snapshot: TerminalModeSnapshot,
  tabs: TerminalTab[],
): { tabId: string; substituted: boolean } {
  if (tabs.some((tab) => tab.id === snapshot.activeTabId)) {
    return { tabId: snapshot.activeTabId, substituted: false };
  }
  return {
    tabId: tabs[tabs.length - 1]?.id ?? '',
    substituted: true,
  };
}

export function restoreTerminalModeFocus(snapshot: TerminalModeSnapshot): boolean {
  const target = snapshot.focusTarget;
  if (!target?.isConnected) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}
