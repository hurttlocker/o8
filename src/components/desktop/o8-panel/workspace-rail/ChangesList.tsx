'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  File,
  FileCode,
  FileDashed,
  FileJs,
  FileJsx,
  FileMd,
  FileRs,
  FileTs,
  FileTsx,
} from '@phosphor-icons/react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import type { ReviewChangedFile } from '@/lib/fleet/types';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

interface WorkspaceReviewResponse {
  changedFiles?: ReviewChangedFile[];
  branch?: string;
  repoSlug?: string;
}

export interface WorkspaceChangesState {
  files: ReviewChangedFile[];
  loading: boolean;
  error: string | null;
  totalAdditions: number;
  totalDeletions: number;
  dirtyFileSet: Set<string>;
  branch: string | null;
  repoSlug: string | null;
  repoPath?: string | null;
  source?: 'local' | 'lane';
  sourceLabel?: string | null;
  patchByPath?: Map<string, string>;
  refresh: () => Promise<void>;
}

function statusColor(status: ReviewChangedFile['status']) {
  if (status === 'added' || status === 'untracked') return 'var(--t-terminal-ansi-bright-green, #22c55e)';
  if (status === 'deleted') return 'var(--t-brand-red, #ef4444)';
  if (status === 'renamed') return 'var(--t-brand-orange, #f97316)';
  return 'var(--t-accent, #2563eb)';
}

function splitPath(path: string) {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop() ?? path;
  return {
    name,
    directory: segments.join('/'),
  };
}

function fileIconForPath(path: string): PhosphorIcon {
  const normalized = path.toLowerCase();
  if (normalized.endsWith('.tsx')) return FileTsx;
  if (normalized.endsWith('.ts')) return FileTs;
  if (normalized.endsWith('.jsx')) return FileJsx;
  if (normalized.endsWith('.js') || normalized.endsWith('.mjs') || normalized.endsWith('.cjs')) return FileJs;
  if (normalized.endsWith('.rs') || normalized.endsWith('/cargo.lock') || normalized.endsWith('/cargo.toml')) return FileRs;
  if (normalized.endsWith('.md') || normalized.endsWith('.mdx')) return FileMd;
  if (normalized.endsWith('.json') || normalized.endsWith('.lock') || normalized.endsWith('.config') || normalized.endsWith('.conf')) return FileCode;
  return File;
}

function statusGlyph(status: ReviewChangedFile['status']) {
  if (status === 'added') return '+';
  if (status === 'deleted') return '-';
  if (status === 'renamed') return 'r';
  if (status === 'untracked') return '?';
  return '';
}

interface WorkspaceChangesSnapshot {
  files: ReviewChangedFile[];
  loading: boolean;
  error: string | null;
  branch: string | null;
  repoSlug: string | null;
}

interface WorkspaceChangesController {
  repoPath: string;
  getSnapshot: () => WorkspaceChangesSnapshot;
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<void>;
}

const EMPTY_WORKSPACE_CHANGES_SNAPSHOT: WorkspaceChangesSnapshot = {
  files: [],
  loading: false,
  error: null,
  branch: null,
  repoSlug: null,
};
const workspaceChangesControllers = new Map<string, WorkspaceChangesController>();
const activeWorkspaceChangesControllers = new Map<WorkspaceChangesController, number>();
let workspaceChangesFallbackId: number | null = null;
let workspaceChangesRefreshQueued = false;

function refreshActiveWorkspaceChanges() {
  return Promise.all([...activeWorkspaceChangesControllers.keys()].map((controller) => controller.refresh()));
}

function scheduleActiveWorkspaceChangesRefresh() {
  if (workspaceChangesRefreshQueued) return;
  workspaceChangesRefreshQueued = true;
  queueMicrotask(() => {
    workspaceChangesRefreshQueued = false;
    void refreshActiveWorkspaceChanges();
  });
}

function syncWorkspaceChangesLifecycle() {
  if (typeof window === 'undefined') return;
  if (activeWorkspaceChangesControllers.size > 0 && workspaceChangesFallbackId === null) {
    window.addEventListener('o8:lifecycle-reconcile', scheduleActiveWorkspaceChangesRefresh);
    workspaceChangesFallbackId = window.setInterval(scheduleActiveWorkspaceChangesRefresh, 300_000);
    return;
  }
  if (activeWorkspaceChangesControllers.size === 0 && workspaceChangesFallbackId !== null) {
    window.removeEventListener('o8:lifecycle-reconcile', scheduleActiveWorkspaceChangesRefresh);
    window.clearInterval(workspaceChangesFallbackId);
    workspaceChangesFallbackId = null;
  }
}

function getWorkspaceChangesController(repoPath: string): WorkspaceChangesController {
  const existing = workspaceChangesControllers.get(repoPath);
  if (existing) return existing;

  let snapshot: WorkspaceChangesSnapshot = EMPTY_WORKSPACE_CHANGES_SNAPSHOT;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const setSnapshot = (next: WorkspaceChangesSnapshot) => {
    snapshot = next;
    notify();
  };
  const controller: WorkspaceChangesController = {
    repoPath,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: async () => {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        setSnapshot({ ...snapshot, loading: true, error: null });
        try {
          // changesOnly=1 keeps this off the slow network `gh` path — the changes
          // view reads only changedFiles/branch/repoSlug, all local git data (#1340).
          const workspaceQuery = `?workspace=${encodeURIComponent(repoPath)}&changesOnly=1`;
          const response = await fetch(`/api/review/workspace${workspaceQuery}`);
          if (!response.ok) throw new Error('Failed to load workspace changes');
          const data = await response.json() as WorkspaceReviewResponse;
          setSnapshot({
            files: Array.isArray(data.changedFiles) ? data.changedFiles : [],
            loading: false,
            error: null,
            branch: typeof data.branch === 'string' ? data.branch : null,
            repoSlug: typeof data.repoSlug === 'string' ? data.repoSlug : null,
          });
        } catch (err) {
          setSnapshot({
            files: [],
            loading: false,
            error: err instanceof Error ? err.message : 'Unable to load workspace changes',
            branch: null,
            repoSlug: null,
          });
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
  workspaceChangesControllers.set(repoPath, controller);
  return controller;
}

export function useWorkspaceChanges(repoPath?: string | null, { active = true }: { active?: boolean } = {}): WorkspaceChangesState {
  const controller = useMemo(() => (repoPath ? getWorkspaceChangesController(repoPath) : null), [repoPath]);
  const subscribe = useCallback((listener: () => void) => (
    controller ? controller.subscribe(listener) : () => undefined
  ), [controller]);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => controller?.getSnapshot() ?? EMPTY_WORKSPACE_CHANGES_SNAPSHOT,
    () => EMPTY_WORKSPACE_CHANGES_SNAPSHOT,
  );

  useEffect(() => {
    if (!controller || !active) return;
    activeWorkspaceChangesControllers.set(controller, (activeWorkspaceChangesControllers.get(controller) ?? 0) + 1);
    syncWorkspaceChangesLifecycle();
    scheduleActiveWorkspaceChangesRefresh();
    return () => {
      const remaining = (activeWorkspaceChangesControllers.get(controller) ?? 1) - 1;
      if (remaining > 0) activeWorkspaceChangesControllers.set(controller, remaining);
      else activeWorkspaceChangesControllers.delete(controller);
      syncWorkspaceChangesLifecycle();
    };
  }, [active, controller]);

  const refresh = useCallback(async () => {
    await controller?.refresh();
  }, [controller]);
  const totalAdditions = useMemo(
    () => snapshot.files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    [snapshot.files],
  );
  const totalDeletions = useMemo(
    () => snapshot.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    [snapshot.files],
  );
  const dirtyFileSet = useMemo(() => new Set(snapshot.files.map((file) => file.path)), [snapshot.files]);

  return {
    files: snapshot.files,
    loading: snapshot.loading,
    error: snapshot.error,
    totalAdditions,
    totalDeletions,
    dirtyFileSet,
    branch: snapshot.branch,
    repoSlug: snapshot.repoSlug,
    repoPath: controller ? repoPath : null,
    source: 'local',
    sourceLabel: 'Local changes',
    patchByPath: new Map(),
    refresh,
  };
}

export function ChangesList({
  changes,
  repoPath,
  selectedFile,
  onSelectFile,
}: {
  changes: WorkspaceChangesState;
  repoPath?: string | null;
  selectedFile: string | null;
  onSelectFile: (filePath: string) => void;
}) {
  if (!repoPath) {
    return (
      <div style={{ paddingTop: 16, paddingRight: 14, paddingBottom: 16, paddingLeft: 14, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 11 }}>
        Select a repo to inspect changes.
      </div>
    );
  }

  if (changes.loading) {
    return (
      <div style={{ paddingTop: 16, paddingRight: 14, paddingBottom: 16, paddingLeft: 14, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 11 }}>
        Loading changes...
      </div>
    );
  }

  if (changes.error) {
    return (
      <div style={{ paddingTop: 16, paddingRight: 14, paddingBottom: 16, paddingLeft: 14, color: 'var(--t-brand-red)', fontFamily: UI_FONT, fontSize: 11 }}>
        {changes.error}
      </div>
    );
  }

  if (changes.files.length === 0) {
    return (
      <div style={{ paddingTop: 16, paddingRight: 14, paddingBottom: 16, paddingLeft: 14, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 11 }}>
        Working tree clean
      </div>
    );
  }

  return (
    <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          minHeight: 32,
          paddingTop: 0,
          paddingRight: 10,
          paddingBottom: 0,
          paddingLeft: 10,
          borderBottom: '1px solid var(--t-divider-subtle)',
          background: 'var(--o8-workspace-rail-header-bg, var(--t-canvas-bg))',
          boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.035)',
          fontFamily: UI_FONT,
        }}
      >
        <span style={{ color: 'var(--t-text-faint)', fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px' }}>
          {changes.files.length} {changes.files.length === 1 ? 'file' : 'files'}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px' }}>
          <span style={{ color: 'var(--t-terminal-ansi-bright-green, #22c55e)' }}>+{changes.totalAdditions}</span>
          <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>-{changes.totalDeletions}</span>
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 5, paddingRight: 5, paddingBottom: 8, paddingLeft: 5 }}>
      {changes.files.map((file) => {
        const selected = selectedFile === file.path;
        const { name, directory } = splitPath(file.path);
        const accent = statusColor(file.status);
        const FileIcon = file.status === 'untracked' ? FileDashed : fileIconForPath(file.path);
        const marker = statusGlyph(file.status);
        return (
          <button
            key={file.path}
            type="button"
            onClick={() => onSelectFile(file.path)}
            title={file.path}
            style={{
              display: 'grid',
              gridTemplateColumns: '17px minmax(0, 1fr) auto',
              alignItems: 'center',
              columnGap: 6,
              width: '100%',
              minHeight: 40,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: selected ? 'var(--t-divider-subtle)' : 'transparent',
              borderLeftWidth: 2,
              borderLeftColor: selected ? accent : 'transparent',
              borderRadius: 8,
              background: selected ? 'var(--t-input-bg)' : 'transparent',
              color: selected ? 'var(--t-text)' : 'var(--t-text-secondary)',
              cursor: 'pointer',
              fontFamily: UI_FONT,
              fontSize: 13.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              lineHeight: 1.25,
              paddingTop: 4,
              paddingRight: 8,
              paddingBottom: 4,
              paddingLeft: 6,
              textAlign: 'left',
            }}
            onMouseEnter={(event) => { if (!selected) event.currentTarget.style.background = 'var(--t-hover)'; }}
            onMouseLeave={(event) => { if (!selected) event.currentTarget.style.background = 'transparent'; }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                width: 17,
                height: 17,
                color: selected ? accent : 'var(--t-text-faint)',
                lineHeight: 1,
              }}
            >
              <FileIcon size={14} weight={selected ? 'duotone' : 'regular'} />
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  right: marker ? -2 : 1,
                  bottom: marker ? -2 : 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: marker ? 8 : 5,
                  height: marker ? 8 : 5,
                  borderRadius: 999,
                  background: accent,
                  boxShadow: '0 0 0 2px var(--t-canvas-bg)',
                  color: '#ffffff',
                  fontFamily: MONO_FONT,
                  fontSize: marker === 'r' ? 5.5 : 6.5,
                  fontWeight: 850,
                  lineHeight: 1,
                  opacity: selected || marker ? 1 : 0.82,
                }}
              >
                {marker}
              </span>
            </span>
            <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--t-text)' : 'var(--t-text)', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25 }}>
                {name}
              </span>
              {directory ? (
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text-faint)', fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px' }}>
                  {directory}
                </span>
              ) : null}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, fontFamily: MONO_FONT }}>
              {(file.additions ?? 0) > 0 ? (
                <span style={{ color: 'var(--t-terminal-ansi-bright-green, #22c55e)', fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px' }}>+{file.additions}</span>
              ) : null}
              {(file.deletions ?? 0) > 0 ? (
                <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)', fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px' }}>-{file.deletions}</span>
              ) : null}
            </span>
          </button>
        );
      })}
      </div>
    </div>
  );
}
