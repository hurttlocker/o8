'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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

export function useWorkspaceChanges(repoPath?: string | null): WorkspaceChangesState {
  const [files, setFiles] = useState<ReviewChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!repoPath) {
      setFiles([]);
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
      setFiles(Array.isArray(data.changedFiles) ? data.changedFiles : []);
    } catch (err) {
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

  const totalAdditions = useMemo(
    () => files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    [files],
  );
  const totalDeletions = useMemo(
    () => files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    [files],
  );
  const dirtyFileSet = useMemo(() => new Set(files.map((file) => file.path)), [files]);

  return {
    files,
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
      <div style={{ paddingTop: 16, paddingRight: 14, paddingBottom: 16, paddingLeft: 14, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>
        Select a repo to inspect changes.
      </div>
    );
  }

  if (changes.loading) {
    return (
      <div style={{ paddingTop: 16, paddingRight: 14, paddingBottom: 16, paddingLeft: 14, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>
        Loading changes...
      </div>
    );
  }

  if (changes.error) {
    return (
      <div style={{ paddingTop: 16, paddingRight: 14, paddingBottom: 16, paddingLeft: 14, color: 'var(--t-brand-red)', fontFamily: UI_FONT, fontSize: 12 }}>
        {changes.error}
      </div>
    );
  }

  if (changes.files.length === 0) {
    return (
      <div style={{ paddingTop: 16, paddingRight: 14, paddingBottom: 16, paddingLeft: 14, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>
        Working tree clean
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingTop: 4, paddingBottom: 4 }}>
      {changes.files.map((file) => {
        const selected = selectedFile === file.path;
        return (
          <button
            key={file.path}
            type="button"
            onClick={() => onSelectFile(file.path)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              width: '100%',
              minHeight: 28,
              border: 'none',
              borderRadius: 0,
              background: selected ? 'var(--t-input-bg)' : 'transparent',
              color: selected ? 'var(--t-text)' : 'var(--t-text-secondary)',
              cursor: 'pointer',
              fontFamily: MONO_FONT,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: 0,
              paddingTop: 0,
              paddingRight: 10,
              paddingBottom: 0,
              paddingLeft: 10,
              textAlign: 'left',
            }}
            onMouseEnter={(event) => { if (!selected) event.currentTarget.style.background = 'var(--t-hover)'; }}
            onMouseLeave={(event) => { if (!selected) event.currentTarget.style.background = 'transparent'; }}
          >
            <span style={{ color: statusColor(file.status), fontSize: 11, lineHeight: '11px', flexShrink: 0 }}>●</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {file.path}
            </span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
              {(file.additions ?? 0) > 0 ? (
                <span style={{ color: 'var(--t-terminal-ansi-bright-green, #22c55e)', fontSize: 10, fontWeight: 700 }}>+{file.additions}</span>
              ) : null}
              {(file.deletions ?? 0) > 0 ? (
                <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)', fontSize: 10, fontWeight: 700 }}>-{file.deletions}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
