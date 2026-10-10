'use client';
/* eslint-disable react-hooks/set-state-in-effect -- repo changes intentionally reset and refetch file tree state */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileNode } from '@/app/dashboard/types';
import { QuickDocs } from './QuickDocs';
import { FileTypeIcon } from './FileTypeIcon';
import { RamsButton } from '../../settings/shared';
import { useWorkspaceFiles, type DirectoryState } from './useWorkspaceFiles';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

function ChevronIcon({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', transition: 'transform 120ms cubic-bezier(0.22, 1, 0.36, 1)', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
      <polyline points="9 18 15 12 9 6" />
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

function relativeSelection(repoPath: string | null | undefined, selectedFile: string | null): string | null {
  if (!repoPath || !selectedFile) return null;
  const prefix = `${repoPath.replace(/\/$/, '')}/`;
  const relative = selectedFile.startsWith(prefix) ? selectedFile.slice(prefix.length) : selectedFile;
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || relative.startsWith('/')) return null;
  return relative;
}

function TreeNode({
  node,
  depth,
  selectedFile,
  expandedDirs,
  dirtyFiles,
  directories,
  onRetry,
  onToggleDir,
  onSelectFile,
}: {
  node: FileNode;
  depth: number;
  selectedFile: string | null;
  expandedDirs: Set<string>;
  dirtyFiles: Set<string>;
  directories: Record<string, DirectoryState>;
  onRetry: (path: string) => void;
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
        aria-expanded={isDir ? open : undefined}
        aria-current={selected ? 'page' : undefined}
        title={node.path}
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
          // Cursor look (Q 2026-07-12): names read in the UI sans at rest —
          // the extension color lives on the ICON only, not the whole row.
          color: 'var(--t-text)',
          cursor: 'pointer',
          fontFamily: UI_FONT,
          fontSize: 13.5,
          fontWeight: 300,
          lineHeight: 1.25,
          letterSpacing: '-0.1px',
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
            <FileTypeIcon name={node.name} size={14} />
          </>
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.name}
        </span>
        {dirty ? (
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--t-terminal-ansi-bright-green, #22c55e)', flexShrink: 0 }} />
        ) : null}
      </button>
      {isDir && open ? (
        directories[node.path]?.loading || !directories[node.path] ? <FolderStatus depth={depth + 1}>Loading folder...</FolderStatus>
          : directories[node.path].error ? <FolderStatus depth={depth + 1}><span>Couldn&apos;t load this folder.</span><RamsButton variant="ghost" onClick={() => onRetry(node.path)}>Retry</RamsButton></FolderStatus>
            : directories[node.path].entries.length === 0 ? <FolderStatus depth={depth + 1}>Empty folder</FolderStatus>
              : directories[node.path].entries.map((child) => (
                <TreeNode key={child.path} node={child} depth={depth + 1} selectedFile={selectedFile} expandedDirs={expandedDirs} dirtyFiles={dirtyFiles} directories={directories} onRetry={onRetry} onToggleDir={onToggleDir} onSelectFile={onSelectFile} />
              ))
      ) : null}
    </>
  );
}

function FolderStatus({ depth, children }: { depth: number; children: React.ReactNode }) {
  return <div role="status" style={{ paddingTop: 6, paddingBottom: 8, paddingLeft: 20 + depth * 14, paddingRight: 8, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, fontFamily: UI_FONT, fontSize: 11, color: 'var(--t-text-muted)' }}>{children}</div>;
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
  const { directories, loadDirectory } = useWorkspaceFiles(repoPath);
  const root = directories['.'];
  const tree = root?.entries ?? [];
  const repoName = repoPath?.split('/').filter(Boolean).pop() ?? 'workspace';
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [rootFilesExpanded, setRootFilesExpanded] = useState(true);
  const treeRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<string | null>(null);
  const selection = relativeSelection(repoPath, selectedFile);
  useEffect(() => { setExpandedDirs(new Set()); setRootFilesExpanded(true); }, [repoPath]);
  useEffect(() => {
    revealRef.current = selection;
    if (!selection) return;
    const parts = selection.split('/');
    const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    setExpandedDirs((current) => new Set([...current, ...ancestors]));
    if (!ancestors.length) setRootFilesExpanded(true);
  }, [repoPath, selection]);
  useEffect(() => {
    const pending = revealRef.current;
    if (!pending || pending !== selection || !root || root.loading || root.error) return;
    const parts = pending.split('/');
    let entries = root.entries;
    // Walk only the selected file's known ancestors. Stop at a failed or
    // missing directory; Retry and Refresh can resume without a fetch loop.
    for (let index = 0; index < parts.length - 1; index += 1) {
      const path = parts.slice(0, index + 1).join('/');
      if (!entries.some((entry) => entry.path === path && entry.type === 'dir')) return;
      const directory = directories[path];
      if (!directory) { void loadDirectory(path); return; }
      if (directory.loading || directory.error) return;
      entries = directory.entries;
    }
    if (!entries.some((entry) => entry.path === pending && entry.type === 'file')) return;
    const scroller = treeRef.current;
    const target = scroller?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!scroller || !target) return;
    const viewport = scroller.getBoundingClientRect();
    const bounds = target.getBoundingClientRect();
    const scale = scroller.clientHeight && viewport.height ? viewport.height / scroller.clientHeight : 1;
    const delta = bounds.top < viewport.top ? bounds.top - viewport.top : bounds.bottom > viewport.bottom ? bounds.bottom - viewport.bottom : 0;
    if (delta) scroller.scrollTop += delta / scale;
    revealRef.current = null;
  }, [directories, expandedDirs, rootFilesExpanded, loadDirectory, root, selection]);
  const handleToggleDir = useCallback((dirPath: string) => {
    const opening = !expandedDirs.has(dirPath);
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (opening) next.add(dirPath);
      else next.delete(dirPath);
      return next;
    });
    if (opening) void loadDirectory(dirPath);
  }, [expandedDirs, loadDirectory]);
  const retryDirectory = (directory: string) => { void loadDirectory(directory, true); };

  const rootDirs = tree.filter((node) => node.type === 'dir');
  const rootFiles = tree.filter((node) => node.type === 'file');

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden' }}>
      <div title={repoPath ?? undefined} style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, borderBottom: '1px solid var(--t-divider-subtle)', color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', paddingTop: 4, paddingRight: 6, paddingBottom: 4, paddingLeft: 10 }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{repoName}</span>
        <button type="button" aria-label="Refresh file tree" title="Refresh files" disabled={!repoPath || root?.loading}
          onClick={() => { retryDirectory('.'); for (const directory of expandedDirs) retryDirectory(directory); }}
          style={{ width: 24, height: 24, border: 'none', borderRadius: 6, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', color: 'inherit', cursor: root?.loading ? 'wait' : 'pointer', opacity: !repoPath || root?.loading ? 0.45 : 1 }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}>
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3a7 7 0 0 0 11.5-1" /></svg>
        </button>
      </div>
      <div ref={treeRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', scrollbarWidth: 'none', paddingTop: 3, paddingBottom: 3 }}>
        <QuickDocs repoPath={repoPath} selectedFile={selectedFile} onSelectFile={onSelectFile} />
        {!repoPath ? (
          <div style={{ paddingTop: 13, paddingRight: 12, paddingBottom: 13, paddingLeft: 12, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>
            Select a repo to browse files.
          </div>
        ) : !root || root.loading ? (
          <div style={{ paddingTop: 13, paddingRight: 12, paddingBottom: 13, paddingLeft: 12, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }}>
            Loading files...
          </div>
        ) : root.error ? (
          <div style={{ paddingTop: 13, paddingRight: 12, paddingBottom: 13, paddingLeft: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 9, color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 12 }} role="status">
            <span>Couldn&apos;t load workspace files.</span>
            <RamsButton variant="ghost" onClick={() => retryDirectory('.')}>Retry</RamsButton>
          </div>
        ) : (
          <>
            {rootDirs.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedFile={selection}
                expandedDirs={expandedDirs}
                dirtyFiles={dirtyFiles}
                directories={directories}
                onRetry={retryDirectory}
                onToggleDir={handleToggleDir}
                onSelectFile={onSelectFile}
              />
            ))}
            {rootFiles.length > 0 ? (
              <>
                <button
                  type="button"
                  aria-expanded={rootFilesExpanded}
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
                    fontSize: 11,
                    fontWeight: 300,
                    letterSpacing: 0,
                    marginTop: 4,
                    paddingTop: 0,
                    paddingRight: 8,
                    paddingBottom: 0,
                    paddingLeft: 7,
                    textAlign: 'left',
                  }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                >
                  <ChevronIcon open={rootFilesExpanded} size={9} />
                  <span>Files</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 16, height: 14, borderRadius: 999, background: 'var(--t-divider-subtle)', color: 'var(--t-text-secondary)', fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 260, marginLeft: 2, paddingTop: 0, paddingRight: 4, paddingBottom: 0, paddingLeft: 4 }}>
                    {rootFiles.length}
                  </span>
                </button>
                {rootFilesExpanded ? rootFiles.map((node) => (
                  <TreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    selectedFile={selection}
                    expandedDirs={expandedDirs}
                    dirtyFiles={dirtyFiles}
                    directories={directories}
                    onRetry={retryDirectory}
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
