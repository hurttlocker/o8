'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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

const UI_FONT = '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

interface WorkspaceReviewResponse {
  changedFiles?: ReviewChangedFile[];
}

export interface WorkspaceChangesState {
  files: ReviewChangedFile[];
  loading: boolean;
  error: string | null;
  totalAdditions: number;
  totalDeletions: number;
  dirtyFileSet: Set<string>;
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

export function useWorkspaceChanges(repoPath?: string | null): WorkspaceChangesState {
  const [files, setFiles] = useState<ReviewChangedFile[]>([]);
  const [sourceRepoPath, setSourceRepoPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentRepoPath = repoPath ?? null;

  const refresh = useCallback(async () => {
    if (!repoPath) {
      setFiles([]);
      setSourceRepoPath(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const workspaceQuery = `?workspace=${encodeURIComponent(repoPath)}`;
      const response = await fetch(`/api/review/workspace${workspaceQuery}`);
      if (!response.ok) throw new Error('Failed to load workspace changes');
      const data = await response.json() as WorkspaceReviewResponse;
      setSourceRepoPath(repoPath);
      setFiles(Array.isArray(data.changedFiles) ? data.changedFiles : []);
    } catch (err) {
      setSourceRepoPath(repoPath);
      setFiles([]);
      setError(err instanceof Error ? err.message : 'Unable to load workspace changes');
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    void refresh();
    if (!repoPath) return;

    const handler = () => { void refresh(); };
    const wsEvents = ['o8:agent-lifecycle', 'o8:lane-lifecycle'];
    for (const eventName of wsEvents) window.addEventListener(eventName, handler);
    const fallbackId = window.setInterval(() => { void refresh(); }, 300_000);
    return () => {
      for (const eventName of wsEvents) window.removeEventListener(eventName, handler);
      window.clearInterval(fallbackId);
    };
  }, [refresh, repoPath]);

  const scopedFiles = useMemo(
    () => (sourceRepoPath === currentRepoPath ? files : []),
    [currentRepoPath, files, sourceRepoPath],
  );
  const totalAdditions = useMemo(
    () => scopedFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    [scopedFiles],
  );
  const totalDeletions = useMemo(
    () => scopedFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    [scopedFiles],
  );
  const dirtyFileSet = useMemo(() => new Set(scopedFiles.map((file) => file.path)), [scopedFiles]);

  return {
    files: scopedFiles,
    loading,
    error,
    totalAdditions,
    totalDeletions,
    dirtyFileSet,
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
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
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
        <span style={{ color: 'var(--t-text-secondary)', fontSize: 10.5, fontWeight: 750 }}>
          {changes.files.length} {changes.files.length === 1 ? 'file' : 'files'}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: MONO_FONT, fontSize: 10, fontWeight: 750 }}>
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
              fontSize: 11.25,
              fontWeight: 650,
              letterSpacing: 0,
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
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--t-text)' : 'var(--t-text-secondary)', fontSize: 11.5 }}>
                {name}
              </span>
              {directory ? (
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text-faint)', fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 500 }}>
                  {directory}
                </span>
              ) : null}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, fontFamily: MONO_FONT }}>
              {(file.additions ?? 0) > 0 ? (
                <span style={{ color: 'var(--t-terminal-ansi-bright-green, #22c55e)', fontSize: 9.5, fontWeight: 700 }}>+{file.additions}</span>
              ) : null}
              {(file.deletions ?? 0) > 0 ? (
                <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)', fontSize: 9.5, fontWeight: 700 }}>-{file.deletions}</span>
              ) : null}
            </span>
          </button>
        );
      })}
      </div>
    </div>
  );
}
