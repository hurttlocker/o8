'use client';

import { lazy, Suspense, useMemo, useState } from 'react';
import { useCommandPaletteHotkey } from '@/components/desktop/use-command-palette-hotkey';
import { canvasCommandActionItems, type CanvasCommands } from './canvas-commands';

const LazyCommandPalette = lazy(() => import('@/components/desktop/CommandPalette').then((module) => ({
  default: module.CommandPalette,
})));

export interface CanvasCommandPaletteProps {
  commands: CanvasCommands;
  repo?: string | null;
}

const ignoreSelection = () => {};

export function CanvasCommandPalette({ commands, repo }: CanvasCommandPaletteProps) {
  const [open, setOpen] = useState(false);
  useCommandPaletteHotkey(setOpen);
  const actionItems = useMemo(() => canvasCommandActionItems(commands), [commands]);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LazyCommandPalette
        open
        onClose={() => setOpen(false)}
        workspace={repo}
        repo={repo}
        actionItems={actionItems}
        onSelectIssue={ignoreSelection}
        onSelectFile={(filePath) => commands.spawnFile(filePath)}
        onSelectAgent={(sessionKey) => commands.spawnChat(sessionKey)}
        onSelectChat={(chatTabId) => commands.spawnChat(chatTabId)}
        onSelectPacket={ignoreSelection}
        onSelectInbox={ignoreSelection}
        onSelectDirective={ignoreSelection}
      />
    </Suspense>
  );
}
