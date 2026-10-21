import { describe, expect, it, vi } from 'vitest';
import { openMainTerminal } from './open-main-terminal';

function handle(repoPath = '/workspace/project', terminal = true) {
  return {
    getTabsSnapshot: () => ({
      tabs: [{ id: 'kept-chat', label: 'Chat', kind: 'orchestrator' as const, lastActivity: 1 }, ...(terminal ? [{ id: 'kept-shell', label: 'Terminal 1', kind: 'terminal' as const, repoPath, lastActivity: 2 }] : [])],
      activeTabId: 'kept-chat',
    }),
    focusTab: vi.fn(() => true),
    openTerminalTab: vi.fn(() => 'new-shell'),
  };
}

describe('main terminal recovery', () => {
  it('focuses the existing shell in the matching workspace without creating or restarting it', async () => {
    const existing = handle();
    const activate = vi.fn();
    const waitForTarget = vi.fn();
    await openMainTerminal({ handles: new Map([['kept-pane', existing]]), repoPath: '/workspace/project', activate, waitForTarget });
    expect(existing.focusTab).toHaveBeenCalledWith('kept-shell');
    expect(existing.openTerminalTab).not.toHaveBeenCalled();
    expect(waitForTarget).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith('kept-pane');
    expect(existing.getTabsSnapshot().tabs.map((tab) => tab.id)).toEqual(['kept-chat', 'kept-shell']);
  });

  it('does not borrow an unrelated repository shell and reuses a shell that mounted while waiting', async () => {
    const unrelated = handle('/workspace/other');
    const restored = handle();
    const activate = vi.fn();
    await openMainTerminal({ handles: new Map([['other-pane', unrelated]]), repoPath: '/workspace/project', activate, waitForTarget: async () => ({ tileId: 'restored-pane', handle: restored }) });
    expect(unrelated.focusTab).not.toHaveBeenCalled();
    expect(restored.focusTab).toHaveBeenCalledWith('kept-shell');
    expect(restored.openTerminalTab).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith('restored-pane');
  });

  it('opens one explicit new shell only when the recovered workspace has none', async () => {
    const target = handle('/workspace/project', false);
    await openMainTerminal({ handles: new Map(), repoPath: '/workspace/project', activate: vi.fn(), waitForTarget: async () => ({ tileId: 'new-pane', handle: target }) });
    expect(target.openTerminalTab).toHaveBeenCalledOnce();
  });
});
