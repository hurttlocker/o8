'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react';
import type { ReviewChangedFile } from '@/lib/fleet/types';
import type { FileNode, WorkspaceSidePanelRepo } from './types';
import {
  THEME_ACCENT,
  THEME_BG_CARD,
  THEME_ROW_HOVER,
  getFileIconColor,
  getFolderColor,
  WorkspaceDiffStatusIcon,
} from './shared';

// ── Tree Helpers ─────────────────────────────────────────────────────
function hasChangedDescendant(node: FileNode, changedFiles: Set<string>): boolean {
  if (node.type === 'file') return changedFiles.has(node.path);
  return node.children?.some((child) => hasChangedDescendant(child, changedFiles)) ?? false;
}

export function filterTreeToChanged(nodes: FileNode[], changedFiles: Set<string>): FileNode[] {
  return nodes
    .map((node) => {
      if (node.type === 'file') {
        return changedFiles.has(node.path) ? node : null;
      }
      const filteredChildren = filterTreeToChanged(node.children ?? [], changedFiles);
      if (filteredChildren.length === 0) return null;
      return { ...node, children: filteredChildren };
    })
    .filter((node): node is FileNode => node !== null);
}

export function filterTreeToEnv(nodes: FileNode[]): FileNode[] {
  const envPattern = /^\.env|\.env\./;
  return nodes
    .map((node) => {
      if (node.type === 'file') {
        const name = node.name.toLowerCase();
        return envPattern.test(name) ? node : null;
      }
      const filteredChildren = filterTreeToEnv(node.children ?? []);
      if (filteredChildren.length === 0) return null;
      return { ...node, children: filteredChildren };
    })
    .filter((node): node is FileNode => node !== null);
}

// ── TreeNode Component ───────────────────────────────────────────────
export function TreeNode({
  node,
  changedFiles,
  changeMap,
  mode = 'all',
  depth = 0,
  onOpenFile,
}: {
  node: FileNode;
  changedFiles: Set<string>;
  changeMap?: Map<string, ReviewChangedFile>;
  mode?: 'all' | 'changes';
  depth?: number;
  onOpenFile: (path: string) => void;
}) {
  const hasChangedChild = node.type === 'dir' && hasChangedDescendant(node, changedFiles);
  const [open, setOpen] = useState(() => mode === 'changes' ? hasChangedChild || depth === 0 : depth === 0 || node.name === 'src');
  const isChanged = node.type === 'file' && changedFiles.has(node.path);
  const changeEntry = node.type === 'file' ? changeMap?.get(node.path) ?? null : null;

  if (node.type === 'file') {
    return (
      <button
        type="button"
        onClick={() => onOpenFile(node.path)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: `5px 12px 5px ${12 + depth * 14}px`,
          border: 'none',
          background: 'transparent',
          color: isChanged ? 'var(--t-text)' : 'var(--t-text-secondary)',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: 12,
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = THEME_ROW_HOVER; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        {mode === 'changes' && changeEntry ? (
          <WorkspaceDiffStatusIcon status={changeEntry.status} />
        ) : (
          <FileText size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: isChanged ? THEME_ACCENT : getFileIconColor(node.name) }} />
        )}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
        {mode === 'changes' && changeEntry ? (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 700 }}>
            {(changeEntry.additions ?? 0) > 0 ? <span style={{ color: '#22c55e' }}>+{changeEntry.additions}</span> : null}
            {(changeEntry.deletions ?? 0) > 0 ? <span style={{ color: '#ef4444' }}>-{changeEntry.deletions}</span> : null}
          </span>
        ) : isChanged ? (
          <span style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: 999, background: THEME_ACCENT, flexShrink: 0 }} />
        ) : null}
      </button>
    );
  }

  const folderColor = getFolderColor(node.name);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: `5px 12px 5px ${12 + depth * 14}px`,
          border: 'none',
          background: 'transparent',
          color: 'var(--t-text)',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: 12,
          fontWeight: 600,
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = THEME_ROW_HOVER; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        {open ? <FolderOpen size={13} strokeWidth={1.6} style={{ color: folderColor, flexShrink: 0 }} /> : <Folder size={13} strokeWidth={1.6} style={{ color: folderColor, flexShrink: 0 }} />}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
        {open ? <ChevronDown size={11} style={{ color: 'var(--t-text-faint)', marginLeft: 'auto', flexShrink: 0 }} /> : <ChevronRight size={11} style={{ color: 'var(--t-text-faint)', marginLeft: 'auto', flexShrink: 0 }} />}
        {hasChangedChild && !open ? (
          <span style={{ width: 6, height: 6, borderRadius: 999, background: THEME_ACCENT, flexShrink: 0 }} />
        ) : null}
      </button>
      {open && node.children ? node.children.map((child) => (
        <TreeNode key={child.path} node={child} changedFiles={changedFiles} changeMap={changeMap} mode={mode} depth={depth + 1} onOpenFile={onOpenFile} />
      )) : null}
    </div>
  );
}

// ── ChangesTab ───────────────────────────────────────────────────────
export const ChangesTab = memo(function ChangesTab({
  repo,
  onOpenFile,
}: {
  repo: WorkspaceSidePanelRepo | null;
  onOpenFile: (path: string, repo: WorkspaceSidePanelRepo | null) => void;
}) {
  const [files, setFiles] = useState<ReviewChangedFile[]>([]);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitLoading, setCommitLoading] = useState(false);
  const [actionToast, setActionToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const repoPath = repo?.localPath ?? null;

  const refreshFiles = useCallback(async () => {
    // Never hit the review/files APIs without a concrete workspace path —
    // the server falls back to process.cwd() and would leak that repo's
    // diff into the panel when the user has removed the real repo.
    if (!repoPath) {
      setFiles([]);
      setTree([]);
      setActionToast(null);
      setLoading(false);
      return;
    }
    const workspaceQuery = `?workspace=${encodeURIComponent(repoPath)}`;
    setLoading(true);
    try {
      const [diffRes, treeRes] = await Promise.all([
        fetch(`/api/review/workspace${workspaceQuery}`),
        fetch(`/api/panel/files${workspaceQuery}`),
      ]);
      if (!diffRes.ok) throw new Error('Failed to load workspace diff');
      if (!treeRes.ok) throw new Error('Failed to load workspace files');
      const diffData = await diffRes.json() as { changedFiles?: ReviewChangedFile[] };
      const treeData = await treeRes.json() as { tree?: FileNode[] };
      setFiles(Array.isArray(diffData.changedFiles) ? diffData.changedFiles : []);
      setTree(Array.isArray(treeData.tree) ? treeData.tree : []);
      setActionToast(null);
    } catch (error) {
      setFiles([]);
      setTree([]);
      setActionToast({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unable to load workspace diff',
      });
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    void refreshFiles();
    // Only subscribe to realtime/poll refreshes when we actually have a repo.
    // Otherwise every WS event would trigger an empty refetch cycle.
    if (!repoPath) return;
    const handler = () => { void refreshFiles(); };
    const wsEvents = ['o8:agent-lifecycle', 'o8:lane-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = window.setInterval(() => { void refreshFiles(); }, 300_000);
    return () => {
      for (const e of wsEvents) window.removeEventListener(e, handler);
      window.clearInterval(fallbackId);
    };
  }, [refreshFiles, repoPath]);

  useEffect(() => {
    // Eagerly clear stale state the moment the repo reference is lost. This
    // prevents the previous repo's diff/tree from lingering on-screen while
    // the next refreshFiles() resolves (or never fires, if repoPath is null).
    if (!repoPath) {
      setFiles([]);
      setTree([]);
      setActionToast(null);
    }
    setCommitMsg('');
  }, [repoPath]);

  const stageAndCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    setCommitLoading(true);
    setActionToast(null);
    try {
      const res = await fetch('/api/review/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMsg }),
      });
      const data = await res.json() as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Commit failed');
      setActionToast({ type: 'success', message: data.message || 'Committed changes' });
      setCommitMsg('');
      await refreshFiles();
    } catch (error) {
      setActionToast({ type: 'error', message: error instanceof Error ? error.message : 'Commit failed' });
    } finally {
      setCommitLoading(false);
    }
  }, [commitMsg, refreshFiles]);

  const totalAdditions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const totalDeletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const hasRepo = Boolean(repo?.localPath);
  const changedFileSet = useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const changeMap = useMemo(() => new Map(files.map((file) => [file.path, file] as const)), [files]);
  const visibleTree = useMemo(
    () => filterTreeToChanged(tree, changedFileSet),
    [tree, changedFileSet],
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderBottom: '1px solid var(--t-divider-subtle)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: '#22c55e' }}>+{totalAdditions}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#ef4444' }}>-{totalDeletions}</span>
        <span style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      </div>

      {files.length > 0 && hasRepo ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--t-divider-subtle)',
            flexShrink: 0,
          }}
        >
          <input
            id="workspace-commit-message"
            name="workspaceCommitMessage"
            aria-label="Workspace commit message"
            type="text"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(event) => setCommitMsg(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && commitMsg.trim()) {
                event.preventDefault();
                void stageAndCommit();
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              border: '1px solid var(--t-panel-border)',
              borderRadius: 8,
              padding: '7px 10px',
              fontSize: 12,
              outline: 'none',
              background: THEME_BG_CARD,
              color: 'var(--t-text)',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          />
          <button
            type="button"
            onClick={() => { void stageAndCommit(); }}
            disabled={!commitMsg.trim() || commitLoading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '7px 10px',
              borderRadius: 8,
              border: 'none',
              background: commitMsg.trim() ? '#16a34a' : 'var(--t-divider)',
              color: commitMsg.trim() ? '#fff' : 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 700,
              cursor: commitMsg.trim() ? 'pointer' : 'default',
              whiteSpace: 'nowrap',
            }}
          >
            <Check size={12} />
            {commitLoading ? 'Committing...' : 'Stage All + Commit'}
          </button>
        </div>
      ) : null}

      {actionToast ? (
        <div
          style={{
            padding: '8px 12px',
            fontSize: 11,
            fontWeight: 600,
            color: actionToast.type === 'success' ? '#15803d' : '#b91c1c',
            background: actionToast.type === 'success' ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
            borderBottom: '1px solid var(--t-divider-subtle)',
            flexShrink: 0,
          }}
        >
          {actionToast.message}
        </div>
      ) : null}

      <div className="cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading changes...</div>
        ) : visibleTree.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>
            {hasRepo ? 'Working tree clean' : 'Select a repo-scoped workspace to inspect changes'}
          </div>
        ) : (
          visibleTree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              changedFiles={changedFileSet}
              changeMap={changeMap}
              mode="changes"
              onOpenFile={(path) => onOpenFile(path, repo)}
            />
          ))
        )}
      </div>
    </div>
  );
});
