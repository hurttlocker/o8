// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { TerminalTab } from './types';
import {
  captureTerminalModeSnapshot,
  resolveTerminalModeEntry,
  resolveTerminalModeReturnTab,
  restoreTerminalModeFocus,
  setWorkspaceTerminalMode,
  type TerminalModePresentation,
} from './terminal-mode';

function tab(overrides: Partial<TerminalTab> & Pick<TerminalTab, 'id' | 'kind'>): TerminalTab {
  return {
    label: overrides.id,
    tmuxSession: null,
    createdAt: 1,
    lastActivity: 1,
    ...overrides,
  } as TerminalTab;
}

describe('Terminal Mode state and resolution', () => {
  it('prefers the active coding session terminal over an existing repo shell', () => {
    const repo = { name: 'repo', localPath: '/repo' };
    const worktree = { name: 'packet', localPath: '/repo/.worktrees/packet', isWorktree: true };
    const activeTab = tab({
      id: 'coding',
      kind: 'chat',
      chatRuntime: 'codex',
      chatSessionKey: 'codex-owned:active',
      repo,
    });
    const resolution = resolveTerminalModeEntry({
      activeTab,
      attachedSessions: [{
        sessionKey: 'codex-owned:active',
        tmuxSession: 'agent-session',
        repo: worktree,
      }],
      preferredRepo: repo,
      tabs: [activeTab, tab({ id: 'shell', kind: 'terminal', tmuxSession: 'shell-session', repo })],
    });

    expect(resolution).toMatchObject({
      kind: 'attached-session',
      session: { tmuxSession: 'agent-session' },
      repo: worktree,
    });
  });

  it('preserves status evidence while resolving an attached coding session', () => {
    const repo = { name: 'repo', localPath: '/repo' };
    const activeTab = tab({
      id: 'coding',
      kind: 'chat',
      chatRuntime: 'codex',
      chatSessionKey: 'codex-owned:evidence',
      repo,
    });
    const statusEvidence = {
      sessionId: 'codex-owned:evidence',
      runtime: 'codex' as const,
      state: 'blocked' as const,
      authority: 'lane-state' as const,
      observedAt: '2026-08-29T12:00:00.000Z',
      summary: 'Lane is waiting for approval.',
      evidence: [{ source: 'lane:lane-evidence.status', value: 'awaiting_human' }],
    };

    const resolution = resolveTerminalModeEntry({
      activeTab,
      attachedSessions: [{
        sessionKey: statusEvidence.sessionId,
        tmuxSession: 'agent-session',
        repo,
        statusEvidence,
      }],
      preferredRepo: repo,
      tabs: [activeTab],
    });

    expect(resolution).toMatchObject({
      kind: 'attached-session',
      session: { statusEvidence },
    });
  });

  it('uses an existing terminal tab for the active repo when no coding session is attached', () => {
    const repo = { name: 'repo', localPath: '/repo' };
    const shell = tab({ id: 'shell', kind: 'terminal', tmuxSession: 'shell-session', repo });
    const resolution = resolveTerminalModeEntry({
      activeTab: tab({ id: 'chat', kind: 'orchestrator', repo }),
      attachedSessions: [],
      preferredRepo: repo,
      tabs: [shell],
    });

    expect(resolution).toEqual({ kind: 'existing-terminal', tabId: 'shell', tmuxSession: 'shell-session' });
  });

  it('requests a new shell in the active repo when neither earlier target exists', () => {
    const repo = { name: 'repo', localPath: '/repo' };
    const resolution = resolveTerminalModeEntry({
      activeTab: tab({ id: 'canvas', kind: 'canvas', repo }),
      attachedSessions: [],
      preferredRepo: null,
      tabs: [],
    });

    expect(resolution).toEqual({ kind: 'new-shell', repo });
  });

  it('scopes presentation state by workspace id', () => {
    const focusTarget = document.createElement('button');
    const presentation = (workspaceId: string): TerminalModePresentation => ({
      terminalTabId: `${workspaceId}-terminal`,
      tmuxSession: `${workspaceId}-session`,
      snapshot: { workspaceId, activeTabId: `${workspaceId}-chat`, focusTarget },
    });
    let state = new Map();
    state = new Map(setWorkspaceTerminalMode(state, 'workspace-a', presentation('workspace-a')));

    expect(state.get('workspace-a')?.terminalTabId).toBe('workspace-a-terminal');
    expect(state.has('workspace-b')).toBe(false);

    state = new Map(setWorkspaceTerminalMode(state, 'workspace-b', presentation('workspace-b')));
    state = new Map(setWorkspaceTerminalMode(state, 'workspace-a', null));
    expect(state.has('workspace-a')).toBe(false);
    expect(state.get('workspace-b')?.terminalTabId).toBe('workspace-b-terminal');
  });

  it('restores the exact active tab and focus target from the entry snapshot', () => {
    const composer = document.createElement('button');
    const terminal = document.createElement('button');
    document.body.append(composer, terminal);
    composer.focus();
    const snapshot = captureTerminalModeSnapshot('workspace-a', 'chat', document.activeElement);
    terminal.focus();

    const restored = resolveTerminalModeReturnTab(snapshot, [
      tab({ id: 'chat', kind: 'orchestrator' }),
      tab({ id: 'terminal', kind: 'terminal', tmuxSession: 'workspace-a-session' }),
    ]);

    expect(restored).toEqual({ tabId: 'chat', substituted: false });
    expect(restoreTerminalModeFocus(snapshot)).toBe(true);
    expect(document.activeElement).toBe(composer);
    composer.remove();
    terminal.remove();
  });
});
