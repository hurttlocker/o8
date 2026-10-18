import type { TerminalTabHandle } from '@/components/desktop/workspace-terminal/types';

type RecoveryHandle = Pick<TerminalTabHandle, 'getTabsSnapshot' | 'focusTab' | 'openTerminalTab'>;

export async function openMainTerminal({ handles, repoPath, activate, waitForTarget, repo }: {
  handles: Map<string, RecoveryHandle>;
  repoPath: string | null;
  activate: (tileId: string) => void;
  waitForTarget: () => Promise<{ tileId: string; handle: RecoveryHandle }>;
  repo?: Parameters<TerminalTabHandle['openTerminalTab']>[0];
}): Promise<void> {
  for (const [tileId, handle] of handles) {
    const snapshot = handle.getTabsSnapshot();
    const terminals = snapshot.tabs.filter((tab) => tab.kind === 'terminal' && !tab.terminalExited && (!repoPath || tab.repoPath === repoPath));
    const tab = terminals.find((candidate) => candidate.id === snapshot.activeTabId) ?? terminals[0];
    if (tab && handle.focusTab(tab.id)) {
      activate(tileId);
      return;
    }
  }
  const target = await waitForTarget();
  // A target can mount while recovery waits for workspace restoration.
  const snapshot = target.handle.getTabsSnapshot();
  const existing = snapshot.tabs.find((tab) => tab.kind === 'terminal' && !tab.terminalExited && (!repoPath || tab.repoPath === repoPath));
  if (!existing || !target.handle.focusTab(existing.id)) target.handle.openTerminalTab(repo);
  activate(target.tileId);
}
