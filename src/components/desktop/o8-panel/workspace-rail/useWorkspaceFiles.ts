'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileNode } from '@/app/dashboard/types';

interface DirectoryEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  ignored?: boolean;
}

export interface DirectoryState {
  entries: FileNode[];
  loading: boolean;
  error: boolean;
}

interface FileSession {
  repoPath: string | null;
  directories: Record<string, DirectoryState>;
  requests: Map<string, AbortController>;
}

const emptyDirectories = (): Record<string, DirectoryState> => Object.create(null) as Record<string, DirectoryState>;

/** Read only opened folders. A repo switch cancels every old request. */
export function useWorkspaceFiles(repoPath?: string | null) {
  const sessionRef = useRef<FileSession | null>(null);
  const [snapshot, setSnapshot] = useState<{ repoPath: string | null; directories: Record<string, DirectoryState> }>({ repoPath: null, directories: emptyDirectories() });
  const loadDirectory = useCallback(async (directory: string, retry = false) => {
    const session = sessionRef.current;
    if (!session?.repoPath || session.requests.has(directory)) return;
    if (!retry && session.directories[directory]) return;
    const controller = new AbortController();
    session.requests.set(directory, controller);
    const publish = (state: DirectoryState) => {
      if (sessionRef.current !== session || controller.signal.aborted) return;
      session.directories[directory] = state;
      setSnapshot({ repoPath: session.repoPath, directories: Object.assign(emptyDirectories(), session.directories) });
    };
    publish({ entries: session.directories[directory]?.entries ?? [], loading: true, error: false });
    try {
      const params = new URLSearchParams({ workspace: session.repoPath, directory });
      const response = await fetch(`/api/panel/files?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error('Directory read failed');
      const data = await response.json() as { entries?: DirectoryEntry[] };
      if (!Array.isArray(data.entries)) throw new Error('Directory listing missing');
      const entries = data.entries.map(entry => ({ name: entry.name, path: entry.path, type: entry.kind === 'directory' ? 'dir' as const : 'file' as const, ignored: entry.ignored }));
      publish({ entries, loading: false, error: false });
    } catch {
      publish({ entries: [], loading: false, error: true });
    } finally {
      session.requests.delete(directory);
    }
  }, []);

  useEffect(() => {
    const session: FileSession = { repoPath: repoPath ?? null, directories: emptyDirectories(), requests: new Map() };
    sessionRef.current = session;
    // Root loading publishes the first snapshot; the render guards old repo data.
    if (repoPath) void loadDirectory('.');
    return () => {
      for (const request of session.requests.values()) request.abort();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [repoPath, loadDirectory]);

  return { directories: snapshot.repoPath === (repoPath ?? null) ? snapshot.directories : emptyDirectories(), loadDirectory };
}
