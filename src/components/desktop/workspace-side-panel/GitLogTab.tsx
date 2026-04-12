'use client';

import { memo, useEffect, useState } from 'react';
import { GitCommit } from 'lucide-react';
import type { WorkspaceGitLogCommit, WorkspaceSidePanelRepo } from './types';
import { THEME_ACCENT, THEME_ACCENT_SOFT, THEME_PANEL_GLASS, formatAge } from './shared';

export const GitLogTab = memo(function GitLogTab({
  repo,
  onSelectCommit,
}: {
  repo: WorkspaceSidePanelRepo | null;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
}) {
  const [commits, setCommits] = useState<WorkspaceGitLogCommit[]>([]);
  const [currentBranch, setCurrentBranch] = useState('main');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    async function fetchLog() {
      setLoading(true);
      try {
        const workspaceQuery = repo?.localPath ? `?workspace=${encodeURIComponent(repo.localPath)}` : '';
        const res = await fetch(`/api/panel/git-log${workspaceQuery}`);
        const data = await res.json() as { commits?: WorkspaceGitLogCommit[]; currentBranch?: string };
        if (!active) return;
        setCommits(Array.isArray(data.commits) ? data.commits : []);
        setCurrentBranch(data.currentBranch ?? 'main');
      } catch {
        if (!active) return;
        setCommits([]);
      } finally {
        if (active) setLoading(false);
      }
    }

    void fetchLog();
    // WS-driven: instant refresh on agent/lane events instead of 45s polling
    const handler = () => { void fetchLog(); };
    const wsEvents = ['o8:agent-lifecycle', 'o8:lane-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = window.setInterval(() => { void fetchLog(); }, 300_000);
    return () => {
      active = false;
      for (const e of wsEvents) window.removeEventListener(e, handler);
      window.clearInterval(fallbackId);
    };
  }, [repo?.localPath]);

  if (loading && commits.length === 0) {
    return <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading git history...</div>;
  }

  if (commits.length === 0) {
    return <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>No commits found</div>;
  }

  return (
    <div className="cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px 8px',
        borderBottom: '1px solid var(--t-divider-subtle)',
        position: 'sticky',
        top: 0,
        background: THEME_PANEL_GLASS,
        zIndex: 2,
      }}>
        <GitCommit size={14} style={{ color: 'var(--t-text-secondary)' }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>Git History</span>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '2px 7px',
          borderRadius: 999,
          background: THEME_ACCENT_SOFT,
          color: THEME_ACCENT,
          fontSize: 10,
          fontWeight: 700,
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}>
          {currentBranch}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--t-text-muted)' }}>
          {commits.length} commits
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', padding: '6px 0' }}>
        {commits.map((commit, index) => {
          const isHead = commit.refs.some((ref) => ref.type === 'head');
          return (
            <button
              key={commit.hash}
              type="button"
              onClick={() => onSelectCommit?.(commit.hash, repo?.localPath ? { workspace: repo.localPath } : undefined)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                width: '100%',
                padding: '9px 12px',
                border: 'none',
                background: 'transparent',
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--t-hover)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'transparent';
              }}
            >
              <div style={{
                width: 16,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                flexShrink: 0,
                position: 'relative',
                paddingTop: 3,
              }}>
                <span style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: isHead ? THEME_ACCENT : 'var(--t-text-faint)',
                  border: isHead ? `2px solid ${THEME_ACCENT_SOFT}` : '2px solid var(--t-divider-subtle)',
                  zIndex: 1,
                }} />
                {index < commits.length - 1 ? (
                  <span style={{
                    width: 1,
                    flex: 1,
                    minHeight: 22,
                    marginTop: 2,
                    background: 'var(--t-divider)',
                  }} />
                ) : null}
              </div>

              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--t-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    minWidth: 0,
                  }}>
                    {commit.subject}
                  </span>
                  {commit.refs.slice(0, 2).map((ref) => (
                    <span
                      key={`${commit.hash}:${ref.type}:${ref.name}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '1px 6px',
                        borderRadius: 999,
                        fontSize: 9,
                        fontWeight: 700,
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        flexShrink: 0,
                        ...(ref.type === 'head'
                          ? { color: THEME_ACCENT, background: THEME_ACCENT_SOFT }
                          : { color: 'var(--t-text-muted)', background: 'var(--t-divider-subtle)' }),
                      }}
                    >
                      {ref.name}
                    </span>
                  ))}
                </div>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  marginTop: 3,
                  fontSize: 10,
                  color: 'var(--t-text-muted)',
                  flexWrap: 'wrap',
                }}>
                  <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', color: 'var(--t-text-secondary)' }}>
                    {commit.shortHash}
                  </span>
                  <span>{commit.author}</span>
                  <span>{formatAge(commit.date)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});
