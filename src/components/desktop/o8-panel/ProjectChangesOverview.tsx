'use client';

/**
 * ProjectChangesOverview — the Workspace tab's "All repos" view.
 *
 * When a whole project is in focus (scope = All repos), the diff tab can't
 * show one repo's changes, so this lists changed files across EVERY repo in
 * the project, grouped by repo with +/- totals. Clicking a repo (or one of its
 * files) focuses that repo — the shared scope flips to that repo and the normal
 * single-repo ReviewPanel takes over.
 *
 * Each group owns its own useWorkspaceChanges(localPath) so this stays a thin
 * composition over the existing per-repo changes hook — no new endpoint.
 */

import { useMemo } from 'react';
import { useWorkspaceChanges } from './workspace-rail/ChangesList';
import { IconFolder } from '../o8-activity-helpers';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

function splitPath(path: string): { name: string; dir: string } {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop() ?? path;
  return { name, dir: parts.join('/') };
}

function RepoChangesGroup({ repo, onPick }: { repo: RepoRegistryEntry; onPick: (localPath: string) => void }) {
  const changes = useWorkspaceChanges(repo.localPath);
  const hasChanges = changes.files.length > 0;
  const summary = changes.loading && !hasChanges
    ? 'Loading…'
    : hasChanges
      ? `${changes.files.length} ${changes.files.length === 1 ? 'file' : 'files'}`
      : 'no changes';

  return (
    <div style={{ borderBottom: '1px solid var(--t-divider-subtle)', opacity: hasChanges ? 1 : 0.5 }}>
      <button
        type="button"
        onClick={() => onPick(repo.localPath)}
        title={`Review ${repo.name}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minHeight: 34,
          paddingTop: 7,
          paddingRight: 12,
          paddingBottom: 7,
          paddingLeft: 12,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          fontFamily: UI_FONT,
          textAlign: 'left',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <span style={{
          width: 18,
          height: 18,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 6,
          background: 'var(--t-panel)',
          flexShrink: 0,
        }}>
          <IconFolder size={12} color="var(--t-text-secondary)" />
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
          {repo.name}
        </span>
        {hasChanges ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: MONO_FONT, fontSize: 10, fontWeight: 750, flexShrink: 0 }}>
            <span style={{ color: 'var(--t-terminal-ansi-bright-green, #22c55e)' }}>+{changes.totalAdditions}</span>
            <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>-{changes.totalDeletions}</span>
          </span>
        ) : null}
        <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--t-text-faint)', flexShrink: 0, fontFamily: UI_FONT }}>
          {summary}
        </span>
      </button>
      {hasChanges ? (
        <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 6 }}>
          {changes.files.map((file) => {
            const { name, dir } = splitPath(file.path);
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => onPick(repo.localPath)}
                title={file.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  minHeight: 24,
                  paddingTop: 3,
                  paddingRight: 12,
                  paddingBottom: 3,
                  paddingLeft: 34,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontFamily: UI_FONT,
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ fontSize: 11.5, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0, maxWidth: '60%' }}>
                  {name}
                </span>
                {dir ? (
                  <span style={{ fontSize: 10.5, color: 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
                    {dir}
                  </span>
                ) : <span style={{ flex: 1 }} />}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 700, flexShrink: 0 }}>
                  {file.additions ? <span style={{ color: 'var(--t-terminal-ansi-bright-green, #22c55e)' }}>+{file.additions}</span> : null}
                  {file.deletions ? <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>-{file.deletions}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function ProjectChangesOverview({
  repos,
  onPickRepo,
}: {
  repos: RepoRegistryEntry[];
  onPickRepo: (localPath: string) => void;
}) {
  const sortedRepos = useMemo(
    () => [...repos].sort((a, b) => a.name.localeCompare(b.name)),
    [repos],
  );

  if (sortedRepos.length === 0) {
    return (
      <div style={{ paddingTop: 16, paddingRight: 14, paddingBottom: 16, paddingLeft: 14, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 11.5 }}>
        No repos in this project.
      </div>
    );
  }

  return (
    <div className="cortex-themed-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
      {sortedRepos.map((repo) => (
        <RepoChangesGroup key={repo.localPath} repo={repo} onPick={onPickRepo} />
      ))}
    </div>
  );
}
