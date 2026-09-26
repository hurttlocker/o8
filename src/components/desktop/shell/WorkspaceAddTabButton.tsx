'use client';

import { HeaderPlayButton } from './HeaderPlayButton';

/** Add a pane to the workspace; dragging its menu items selects an exact edge. */
export function WorkspaceAddTabButton({ workspaceId, ariaSuffix }: { workspaceId: string; ariaSuffix?: string }) {
  const addPane = (kind: 'chat' | 'terminal') => {
    window.dispatchEvent(new CustomEvent('o8:request-split-workspace-tab', { detail: { kind, direction: 'right', workspaceId } }));
  };

  return (
    <HeaderPlayButton
      onSpawnChat={() => addPane('chat')}
      onSpawnTerminal={() => addPane('terminal')}
      ariaSuffix={ariaSuffix}
      paneMode
    />
  );
}
