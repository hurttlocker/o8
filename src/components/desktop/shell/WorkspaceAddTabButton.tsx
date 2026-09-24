'use client';

import { HeaderPlayButton } from './HeaderPlayButton';

/** Route a new tab to the current workspace, leaving the bottom panel alone. */
export function WorkspaceAddTabButton({ workspaceId, ariaSuffix }: { workspaceId: string; ariaSuffix?: string }) {
  const spawn = (kind: 'orchestrator' | 'terminal') => {
    window.dispatchEvent(new CustomEvent('o8:request-spawn-tab', { detail: { kind, workspaceId } }));
  };
  const split = (kind: 'chat' | 'terminal', direction: 'right' | 'below') => {
    window.dispatchEvent(new CustomEvent('o8:request-split-workspace-tab', { detail: { kind, direction, workspaceId } }));
  };

  return (
    <HeaderPlayButton
      onSpawnChat={() => spawn('orchestrator')}
      onSpawnTerminal={() => spawn('terminal')}
      onSplitTab={split}
      ariaSuffix={ariaSuffix}
    />
  );
}
