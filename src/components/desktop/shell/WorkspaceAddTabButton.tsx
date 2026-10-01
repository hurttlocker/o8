'use client';

import { useState } from 'react';
import { HeaderPlayButton } from './HeaderPlayButton';
import { SavedMachinePicker } from './SavedMachinePicker';

/** Add a pane to the workspace; dragging its menu items selects an exact edge. */
export function WorkspaceAddTabButton({ workspaceId, ariaSuffix }: { workspaceId: string; ariaSuffix?: string }) {
  const [machinePickerOpen, setMachinePickerOpen] = useState(false);
  const addPane = (kind: 'chat' | 'terminal') => {
    window.dispatchEvent(new CustomEvent('o8:request-split-workspace-tab', { detail: { kind, direction: 'right', workspaceId } }));
  };

  return (
    <>
    <HeaderPlayButton
      onSpawnChat={() => addPane('chat')}
      onSpawnTerminal={() => addPane('terminal')}
      onOpenSavedMachines={() => setMachinePickerOpen(true)}
      ariaSuffix={ariaSuffix}
      paneMode
    />
    {machinePickerOpen ? <SavedMachinePicker workspaceId={workspaceId} onClose={() => setMachinePickerOpen(false)} /> : null}
    </>
  );
}
