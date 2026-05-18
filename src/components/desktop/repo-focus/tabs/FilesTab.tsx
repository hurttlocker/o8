'use client';

import { useEffect, useState } from 'react';
import type { ReviewChangedFile, WorkflowReviewSnapshot } from '@/lib/fleet/types';
import type { RepoFocusRepo } from '../types';

interface FilesTabProps {
  repo: RepoFocusRepo;
  onSelectFile?: (repoPath: string, filePath: string) => void;
}

const STATUS_LABEL: Record<ReviewChangedFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

const STATUS_COLOR: Record<ReviewChangedFile['status'], string> = {
  modified: '#f59e0b',
  added: '#22c55e',
  deleted: '#ef4444',
  renamed: '#3b82f6',
  untracked: '#94a3b8',
};

export function FilesTab({ repo, onSelectFile }: FilesTabProps) {
  const [snapshot, setSnapshot] = useState<WorkflowReviewSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const repoPath = repo.localPath;

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const load = () => {
      const url = `/api/review/workspace?workspace=${encodeURIComponent(repoPath)}`;
      fetch(url)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data && Array.isArray(data.changedFiles)) {
            setSnapshot(data as WorkflowReviewSnapshot);
            setError(null);
          } else if (data?.error) {
            setError(typeof data.error === 'string' ? data.error : 'Failed to load changes');
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    load();
    timer = window.setInterval(load, 8000) as unknown as number;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [repoPath]);

  const files = snapshot?.changedFiles ?? [];
  const branch = snapshot?.branch ?? repo.defaultBranch;
  const ahead = snapshot?.ahead ?? 0;
  const behind = snapshot?.behind ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--t-divider)',
          fontSize: 11,
          color: 'var(--t-text-muted)',
          fontFamily: 'var(--font-sans-system)',
          letterSpacing: '-0.005em',
        }}
      >
        <span>
          {loading && !snapshot
            ? 'Loading…'
            : error
              ? error
              : files.length === 0
                ? 'Working tree clean'
                : `${files.length} changed · ${branch}`}
        </span>
        {ahead > 0 || behind > 0 ? (
          <span style={{ display: 'flex', gap: 8 }}>
            {ahead > 0 ? <span style={{ color: '#22c55e' }}>↑{ahead}</span> : null}
            {behind > 0 ? <span style={{ color: '#f59e0b' }}>↓{behind}</span> : null}
          </span>
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none' }}>
        {files.length === 0 && !loading ? (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--t-text-muted)',
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            No uncommitted changes.
          </div>
        ) : (
          <div style={{ padding: '4px 0' }}>
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => onSelectFile?.(repoPath, file.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '6px 12px',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'var(--font-sans-system)',
                  letterSpacing: '-0.005em',
                  transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span
                  style={{
                    width: 16,
                    fontSize: 10,
                    fontWeight: 600,
                    color: STATUS_COLOR[file.status],
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}
                >
                  {STATUS_LABEL[file.status]}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    color: 'var(--t-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={file.path}
                >
                  {file.path}
                </span>
                {(file.additions || file.deletions) ? (
                  <span style={{ display: 'flex', gap: 6, fontSize: 10, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                    {file.additions ? <span style={{ color: '#22c55e' }}>+{file.additions}</span> : null}
                    {file.deletions ? <span style={{ color: '#ef4444' }}>−{file.deletions}</span> : null}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
