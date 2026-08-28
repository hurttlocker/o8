'use client';

import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useCommandPaletteHotkey } from '@/components/desktop/use-command-palette-hotkey';
import type { CommandPaletteFileItem } from '@/components/desktop/CommandPalette';
import { canvasCommandActionItems, type CanvasCommands } from './canvas-commands';
import { listCanvasFiles, resolveCanvasFilePath } from './canvas-files';

const LazyCommandPalette = lazy(() => import('@/components/desktop/CommandPalette').then((module) => ({
  default: module.CommandPalette,
})));

export interface CanvasCommandPaletteProps {
  commands: CanvasCommands;
  repo?: string | null;
  fetchImpl?: typeof fetch;
}

const ignoreSelection = () => {};
const fileCache = new Map<string, CommandPaletteFileItem[]>();

export function CanvasCommandPalette({ commands, repo, fetchImpl }: CanvasCommandPaletteProps) {
  const [mode, setMode] = useState<'commands' | 'files' | null>(null);
  const [fileResult, setFileResult] = useState<{ repo: string; items: CommandPaletteFileItem[] } | null>(null);
  const modeSetter = useCallback((target: 'commands' | 'files'): Dispatch<SetStateAction<boolean>> => (
    (next) => setMode((current) => {
      const open = current === target;
      const shouldOpen = typeof next === 'function' ? next(open) : next;
      return shouldOpen ? target : null;
    })
  ), []);
  const setCommandsOpen = useMemo(() => modeSetter('commands'), [modeSetter]);
  const setFilesOpen = useMemo(() => modeSetter('files'), [modeSetter]);
  useCommandPaletteHotkey(setCommandsOpen, 'k');
  useCommandPaletteHotkey(setFilesOpen, 'p');
  const actionItems = useMemo(() => canvasCommandActionItems(commands), [commands]);

  useEffect(() => {
    if (mode !== 'files' || !repo) return;
    let cancelled = false;
    void listCanvasFiles(repo, fetchImpl ?? fetch)
      .then((entries) => entries.map((entry) => ({
        path: resolveCanvasFilePath(repo, entry.path),
        title: entry.name,
        detail: entry.path,
      })))
      .then((items) => {
        if (cancelled) return;
        fileCache.set(repo, items);
        setFileResult({ repo, items });
      })
      .catch(() => {
        // Cached files remain usable if a refresh fails.
      });
    return () => { cancelled = true; };
  }, [fetchImpl, mode, repo]);

  if (!mode) return null;
  return (
    <Suspense fallback={null}>
      <LazyCommandPalette
        open
        onClose={() => setMode(null)}
        workspace={repo}
        repo={repo}
        actionItems={actionItems}
        initialScope={mode === 'files' ? 'file' : 'all'}
        fileItems={mode === 'files' ? (
          fileResult && fileResult.repo === repo
            ? fileResult.items
            : (repo ? fileCache.get(repo) ?? [] : [])
        ) : undefined}
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
