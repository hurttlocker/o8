'use client';

import { memo, useEffect, useMemo, useState } from 'react';
import type { FileNode, WorkspaceSidePanelRepo } from './types';
import { TreeNode, filterTreeToEnv } from './ChangesTab';

export const FilesTab = memo(function FilesTab({
  repo,
  mode,
  onOpenFile,
}: {
  repo: WorkspaceSidePanelRepo | null;
  mode: 'all' | 'env';
  onOpenFile: (path: string, repo: WorkspaceSidePanelRepo | null) => void;
}) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const workspaceQuery = useMemo(() => (
    repo?.localPath ? `?workspace=${encodeURIComponent(repo.localPath)}` : ''
  ), [repo?.localPath]);

  useEffect(() => {
    let active = true;
    async function fetchTree() {
      setLoading(true);
      try {
        const res = await fetch(`/api/panel/files${workspaceQuery}`);
        if (!res.ok) throw new Error('Unable to load file tree');
        const data = await res.json() as { tree?: FileNode[]; changedFiles?: string[] };
        if (!active) return;
        setTree(Array.isArray(data.tree) ? data.tree : []);
        setChangedFiles(new Set(Array.isArray(data.changedFiles) ? data.changedFiles : []));
      } catch {
        if (!active) return;
        setTree([]);
        setChangedFiles(new Set());
      } finally {
        if (active) setLoading(false);
      }
    }
    void fetchTree();
    // WS-driven: instant refresh on agent/lane events instead of 30s polling
    const handler = () => { void fetchTree(); };
    const wsEvents = ['o8:agent-lifecycle', 'o8:lane-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = window.setInterval(() => { void fetchTree(); }, 300_000);
    return () => {
      active = false;
      for (const e of wsEvents) window.removeEventListener(e, handler);
      window.clearInterval(fallbackId);
    };
  }, [workspaceQuery]);

  const visibleTree = useMemo(
    () => (mode === 'env' ? filterTreeToEnv(tree) : tree),
    [mode, tree],
  );

  return (
    <div className="cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto', paddingTop: 6, paddingBottom: 6 }}>
      {loading ? (
        <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading files...</div>
      ) : visibleTree.length === 0 ? (
        <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>
          {mode === 'env' ? 'No env files found' : 'No files found'}
        </div>
      ) : (
        visibleTree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            changedFiles={changedFiles}
            onOpenFile={(path) => onOpenFile(path, repo)}
          />
        ))
      )}
    </div>
  );
});
