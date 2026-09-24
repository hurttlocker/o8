'use client';

import { HeaderPlayButton } from './HeaderPlayButton';

/** Route a new tab to the current workspace, leaving the bottom panel alone. */
export function WorkspaceAddTabButton({ workspaceId }: { workspaceId: string }) {
  const spawn = (kind: 'orchestrator' | 'chat' | 'terminal') => {
    window.dispatchEvent(new CustomEvent('o8:request-spawn-tab', { detail: { kind, workspaceId } }));
  };

  return (
    <HeaderPlayButton
      onSpawnOrchestrator={() => spawn('orchestrator')}
      onSpawnChat={() => spawn('chat')}
      onSpawnTerminal={() => spawn('terminal')}
    />
  );
}
