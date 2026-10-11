'use client';

import { useEffect, useId, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';
import { Check, ChevronDown, Copy, FileText, Folder, GitBranch, RefreshCw } from './lucide-shims';
import type { ReviewWorktreeSummary } from '@/lib/fleet/types';
import type { WorkspaceChangesState } from './o8-panel/workspace-rail/ChangesList';

const META: CSSProperties = { fontSize: 9.5, fontWeight: 260, color: 'var(--t-text-muted)', lineHeight: 1.5 };
const BUTTON: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  minHeight: 30, borderWidth: 0, borderRadius: 8, background: 'transparent', color: 'var(--t-text-secondary)',
  fontFamily: 'inherit', fontSize: 11, fontWeight: 300, cursor: 'pointer',
  paddingTop: 5, paddingRight: 8, paddingBottom: 5, paddingLeft: 8,
};
const hover = (event: SyntheticEvent<HTMLButtonElement>) => { event.currentTarget.style.background = 'var(--t-hover)'; };
const rest = (event: SyntheticEvent<HTMLButtonElement>) => { event.currentTarget.style.background = 'transparent'; };

function Action({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} onMouseEnter={hover} onMouseLeave={rest} onFocus={hover} onBlur={rest}
    style={{ ...BUTTON, ...props.style }}>{children}</button>;
}

function basename(value: string) { return value.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || value; }
function navigablePath(worktree: ReviewWorktreeSummary): string | null {
  const value = worktree.absolutePath ?? worktree.path;
  return /^(\/|[a-z]:[\\/]|\\\\)/i.test(value) ? value : null;
}

/** Workspace identity belongs to the chat; other worktrees open only in Files. */
export function WorkspaceContextSection({ repoPath, repoName, changes, onBrowseFiles, onReviewChanges, controls }: {
  repoPath: string | null;
  repoName?: string | null;
  changes: WorkspaceChangesState;
  onBrowseFiles: (path: string) => void;
  onReviewChanges: () => void;
  controls?: ReactNode;
}) {
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const listId = useId();
  const allWorktrees = changes.worktrees ?? [];
  const current = allWorktrees.find(tree => tree.isCurrent);
  const isWorktree = current && current !== allWorktrees[0];
  const worktrees = allWorktrees.filter(tree => tree.isCurrent || !/[/\\]\.claude[/\\]worktrees[/\\]agent-/.test(tree.path));
  const query = filter.trim().toLowerCase();
  const visibleWorktrees = worktrees.filter(tree => !query || `${tree.path} ${tree.branch ?? ''}`.toLowerCase().includes(query));
  const ordered = [...visibleWorktrees.filter(tree => tree.isCurrent), ...visibleWorktrees.filter(tree => !tree.isCurrent)];
  const branch = changes.branch && changes.branch !== 'unknown'
    ? changes.branch === '(detached)' ? 'Detached HEAD' : changes.branch
    : changes.loading ? 'Reading Git context…' : 'No Git branch';
  const name = repoName?.split('/').pop() || (repoPath ? basename(repoPath) : 'Home');
  const copyPath = async () => {
    if (!repoPath) return;
    try { await navigator.clipboard.writeText(repoPath); setCopyState('copied'); }
    catch { setCopyState('failed'); }
  };

  return <section aria-label="Workspace context" data-workspace-context="" style={{
    borderBottom: '1px solid var(--t-divider)', paddingBottom: 10, flexShrink: 0,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 28 }}>
      <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-muted)' }}>Workspace</span>
      <div style={{ display: 'flex', gap: 2 }}>
        {repoPath ? <Action aria-label="Refresh workspace context" title="Refresh workspace context" disabled={changes.loading}
          onClick={() => { void changes.refresh(); }} style={{ paddingRight: 5, paddingLeft: 5, opacity: changes.loading ? 0.45 : 1 }}>
          <RefreshCw size={13} strokeWidth={1.6} />
        </Action> : null}
        {controls}
      </div>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, marginTop: 3 }}>
      <Folder size={15} strokeWidth={1.6} style={{ color: 'var(--t-text-muted)', flexShrink: 0 }} />
      <span title={name} style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', fontSize: 13.5, fontWeight: 300 }}>{name}</span>
      {repoPath && current ? <span style={META}>{isWorktree ? 'Worktree' : 'Local checkout'}</span> : null}
    </div>
    {repoPath ? <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 7, color: 'var(--t-text-secondary)' }}>
        <GitBranch size={13} strokeWidth={1.6} style={{ flexShrink: 0, color: 'var(--t-text-muted)' }} />
        <span title={branch} style={{ overflow: 'hidden', whiteSpace: 'nowrap', minWidth: 0, fontSize: 12, fontWeight: 300 }}>{branch}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 3 }}>
        <span title={repoPath} style={{ ...META, minWidth: 0, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{current?.path ?? repoPath}</span>
        <Action aria-label="Copy workspace path" title={copyState === 'copied' ? 'Path copied' : 'Copy workspace path'} onClick={() => { void copyPath(); }}
          style={{ minHeight: 24, paddingRight: 5, paddingLeft: 5 }}>
          {copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
        </Action>
      </div>
      {copyState === 'failed' ? <div role="status" style={META}>Couldn’t copy. Select the path to copy it.</div> : null}
      <div style={{ display: 'flex', gap: 4, marginTop: 7 }}>
        <Action onClick={() => onBrowseFiles(repoPath)} style={{ flex: 1, justifyContent: 'flex-start' }}><FileText size={14} strokeWidth={1.6} />Files</Action>
        <Action onClick={onReviewChanges} style={{ flex: 1, justifyContent: 'flex-start' }}>
          <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1 }}>±</span>Changes
          <span style={{ ...META, marginLeft: 'auto' }}>{changes.loading ? '…' : changes.error ? '—' : changes.files.length}</span>
        </Action>
      </div>
      {changes.error ? <div role="status" style={{ ...META, marginTop: 4 }}>
        Git context couldn’t load. <Action onClick={() => { void changes.refresh(); }} style={{ minHeight: 20, fontSize: 10 }}>Retry</Action>
      </div> : changes.loading ? <div role="status" style={{ ...META, marginTop: 4 }}>Refreshing workspace…</div>
        : changes.branch && changes.branch !== 'unknown' ? <div style={{ ...META, marginTop: 4, display: 'flex', gap: 6 }}>
          {changes.files.length ? <><span>{changes.files.length} changed {changes.files.length === 1 ? 'file' : 'files'}</span>
            <span style={{ color: 'var(--t-success)' }}>+{changes.totalAdditions}</span><span style={{ color: 'var(--t-danger)' }}>−{changes.totalDeletions}</span></>
            : 'Working tree clean'}
        </div> : null}
      {worktrees.length > 0 ? <div style={{ borderTop: '1px solid var(--t-divider-subtle)', marginTop: 10, paddingTop: 5 }}>
        <Action aria-expanded={worktreesOpen} aria-controls={listId} onClick={() => setWorktreesOpen(!worktreesOpen)}
          style={{ width: '100%', justifyContent: 'flex-start', paddingLeft: 0, paddingRight: 0 }}>
          <ChevronDown size={12} style={{ transform: worktreesOpen ? undefined : 'rotate(-90deg)' }} />
          Worktrees<span style={{ ...META, marginLeft: 'auto' }}>{worktrees.length}</span>
        </Action>
        {worktreesOpen ? <div id={listId}>
          {worktrees.length > 6 ? <input aria-label="Filter worktrees" placeholder="Find a branch or worktree" value={filter} onChange={event => setFilter(event.target.value)}
            style={{ width: '100%', minHeight: 30, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider-subtle)', borderRadius: 6,
              background: 'transparent', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 11, fontWeight: 300,
              paddingTop: 4, paddingRight: 7, paddingBottom: 4, paddingLeft: 7, marginBottom: 5 }} /> : null}
          <div style={{ maxHeight: 180, overflowY: 'auto', scrollbarWidth: 'none' }}>
            {ordered.map(tree => {
              const path = tree.isCurrent ? repoPath : navigablePath(tree);
              const unavailable = tree.isBare || Boolean(tree.prunableReason) || !path;
              const label = tree.isDetached ? `Detached · ${tree.head ?? 'HEAD'}` : tree.branch || basename(tree.path);
              return <Action key={tree.path} title={unavailable ? tree.prunableReason || 'This checkout cannot be browsed' : `Browse files in ${tree.path}`}
                aria-label={`Browse ${label} files`} disabled={unavailable} onClick={() => { if (path) onBrowseFiles(path); }}
                style={{ width: '100%', minHeight: 42, justifyContent: 'flex-start', textAlign: 'left', opacity: unavailable ? 0.45 : 1 }}>
                <Folder size={13} strokeWidth={1.6} style={{ flexShrink: 0, color: 'var(--t-text-muted)' }} />
                <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                  <span style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>{label}</span>
                  <span style={{ ...META, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{tree.path}</span>
                </span>
                {tree.isCurrent ? <span style={META}>This chat</span> : tree === allWorktrees[0] ? <span style={META}>Main checkout</span> : null}
              </Action>;
            })}
          </div>
          {!ordered.length ? <div role="status" style={{ ...META, paddingTop: 8, paddingBottom: 8 }}>No matching worktrees</div> : null}
          <div style={{ ...META, marginTop: 5 }}>Browse files here. This chat stays in its workspace.</div>
        </div> : null}
      </div> : null}
    </> : <div style={{ ...META, marginTop: 7 }}>This chat has no project attached.</div>}
  </section>;
}
