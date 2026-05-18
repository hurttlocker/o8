'use client';
/* eslint-disable react-hooks/set-state-in-effect -- repo changes intentionally reset and refetch file tree state */

import { useCallback, useEffect, useState } from 'react';
import type { FileNode } from '../../workspace-side-panel/types';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

interface FilesResponse {
  tree?: FileNode[];
  root?: string | null;
}

function ChevronIcon({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', transition: 'transform 120ms cubic-bezier(0.22, 1, 0.36, 1)', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function FileIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function FolderIcon({ open, size = 14 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      {open ? <line x1="2" y1="10" x2="22" y2="10" /> : null}
    </svg>
  );
}

function extensionColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'var(--t-accent, #2563eb)';
    case 'js':
    case 'jsx':
      return 'var(--t-brand-orange, #f59e0b)';
    case 'json':
      return 'var(--t-brand-orange, #f97316)';
    case 'md':
    case 'mdx':
      return 'var(--t-text-secondary)';
    case 'css':
    case 'scss':
      return 'var(--t-brand-red, #ef4444)';
    case 'html':
      return 'var(--t-brand-red, #ef4444)';
    case 'rs':
      return 'var(--t-brand-orange, #f97316)';
    case 'toml':
    case 'yaml':
    case 'yml':
      return 'var(--t-text-muted)';
    case 'svg':
    case 'png':
    case 'jpg':
    case 'ico':
      return 'var(--t-terminal-ansi-bright-green, #22c55e)';
    default:
      return 'var(--t-text-secondary)';
  }
}

function TreeNode({
  node,
  depth,
  selectedFile,
  expandedDirs,
  dirtyFiles,
  onToggleDir,
  onSelectFile,
}: {
  node: FileNode;
  depth: number;
  selectedFile: string | null;
  expandedDirs: Set<string>;
  dirtyFiles: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isDir = node.type === 'dir';
  const open = expandedDirs.has(node.path);
  const selected = selectedFile === node.path;
  const dirty = dirtyFiles.has(node.path);

  return (
    <>
      <button
        type="button"
        onClick={() => { if (isDir) onToggleDir(node.path); else onSelectFile(node.path); }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          width: '100%',
          height: 24,
          border: 'none',
          borderRadius: 0,
          background: selected ? 'var(--t-input-bg)' : 'transparent',
          color: isDir ? 'var(--t-text)' : extensionColor(node.name),
          cursor: 'pointer',
          fontFamily: MONO_FONT,
          fontSize: 11,
          fontWeight: isDir ? 650 : 450,
          letterSpacing: 0,
          paddingTop: 0,
          paddingRight: 8,
          paddingBottom: 0,
          paddingLeft: 7 + depth * 14,
          textAlign: 'left',
          transition: 'background 80ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onMouseEnter={(event) => { if (!selected) event.currentTarget.style.background = 'var(--t-hover)'; }}
        onMouseLeave={(event) => { if (!selected) event.currentTarget.style.background = 'transparent'; }}
      >
        {isDir ? (
          <>
            <ChevronIcon open={open} size={10} />
            <FolderIcon open={open} size={13} />
          </>
        ) : (
          <>
            <span style={{ width: 10, flexShrink: 0 }} />
            <FileIcon size={13} />
          </>
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.name}
        </span>
        {dirty ? (
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--t-terminal-ansi-bright-green, #22c55e)', flexShrink: 0 }} />
        ) : null}
      </button>
      {isDir && open && node.children ? (
        node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedFile={selectedFile}
            expandedDirs={expandedDirs}
            dirtyFiles={dirtyFiles}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
          />
        ))
      ) : null}
    </>
  );
}

export function AllFilesTree({
  repoPath,
  selectedFile,
  dirtyFiles,
  onSelectFile,
}: {
  repoPath?: string | null;
  selectedFile: string | null;
  dirtyFiles: Set<string>;
  onSelectFile: (filePath: string) => void;
}) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [repoName, setRepoName] = useState('workspace');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [rootFilesExpanded, setRootFilesExpanded] = useState(false);

  useEffect(() => {
    if (!repoPath) {
      setTree([]);
      setRepoName('workspace');
      setError(null);
      setLoading(false);
      setExpandedDirs(new Set());
      setRootFilesExpanded(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/panel/files?workspace=${encodeURIComponent(repoPath)}`)
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load workspace files');
        return response.json() as Promise<FilesResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setTree(Array.isArray(data.tree) ? data.tree : []);
        const root = data.root ?? repoPath;
        setRepoName(root.split('/').pop() ?? root);
      })
      .catch((err) => {
        if (!cancelled) {
          setTree([]);
          setError(err instanceof Error ? err.message : 'Unable to load workspace files');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [repoPath]);

  const handleToggleDir = useCallback((dirPath: string) => {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  const directories = tree.filter((node) => node.type === 'dir');
  const rootFiles = tree.filter((node) => node.type === 'file');

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, borderBottom: '1px solid var(--t-divider-subtle)', color: 'var(--t-text-muted)', fontFamily: MONO_FONT, fontSize: 11, fontWeight: 700, letterSpacing: 0, paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10 }}>
        {repoName}
      </div>
      <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingTop: 3, paddingBottom: 3 }}>
        {!repoPath ? (
          <div style={{ paddingTop: 13, paddingRight: 12, paddingBottom: 13, paddingLeft: 12, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>
            Select a repo to browse files.
          </div>
        ) : loading ? (
          <div style={{ paddingTop: 13, paddingRight: 12, paddingBottom: 13, paddingLeft: 12, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>
            Loading files...
          </div>
        ) : error ? (
          <div style={{ paddingTop: 13, paddingRight: 12, paddingBottom: 13, paddingLeft: 12, color: 'var(--t-brand-red)', fontFamily: UI_FONT, fontSize: 12 }}>
            {error}
          </div>
        ) : (
          <>
            {directories.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedFile={selectedFile}
                expandedDirs={expandedDirs}
                dirtyFiles={dirtyFiles}
                onToggleDir={handleToggleDir}
                onSelectFile={onSelectFile}
              />
            ))}
            {rootFiles.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => setRootFilesExpanded((open) => !open)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    width: '100%',
                    height: 24,
                    border: 'none',
                    borderRadius: 0,
                    background: 'transparent',
                    color: 'var(--t-text-muted)',
                    cursor: 'pointer',
                    fontFamily: UI_FONT,
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: 0,
                    marginTop: 4,
                    paddingTop: 0,
                    paddingRight: 8,
                    paddingBottom: 0,
                    paddingLeft: 7,
                    textAlign: 'left',
                    textTransform: 'uppercase',
                  }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                >
                  <ChevronIcon open={rootFilesExpanded} size={9} />
                  <span>Files</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 16, height: 14, borderRadius: 999, background: 'var(--t-divider-subtle)', color: 'var(--t-text-secondary)', fontFamily: MONO_FONT, fontSize: 9, fontWeight: 800, marginLeft: 2, paddingTop: 0, paddingRight: 4, paddingBottom: 0, paddingLeft: 4 }}>
                    {rootFiles.length}
                  </span>
                </button>
                {rootFilesExpanded ? rootFiles.map((node) => (
                  <TreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    selectedFile={selectedFile}
                    expandedDirs={expandedDirs}
                    dirtyFiles={dirtyFiles}
                    onToggleDir={handleToggleDir}
                    onSelectFile={onSelectFile}
                  />
                )) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
