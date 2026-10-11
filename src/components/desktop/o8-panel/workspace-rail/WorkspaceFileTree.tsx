'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FileTree, useFileTree, useFileTreeSelector } from '@pierre/trees/react';
import type { FileTreeBatchOperation, FileTreeIcons, GitStatusEntry } from '@pierre/trees';
import type { FileNode } from '@/app/dashboard/types';
import { useTheme } from '@/lib/theme/context';
import { getPalette } from '@/lib/theme/registry';
import type { WorkspaceFileTreeProps } from './AllFilesTree';
import { useWorkspaceFiles, type DirectoryState } from './useWorkspaceFiles';

const TREE_ICONS: FileTreeIcons = {
  set: 'complete', colored: true,
  byFileName: { 'package.json': 'file-tree-builtin-npm', 'tsconfig.json': 'file-tree-builtin-typescript', 'agents.md': 'workspace-file-agents' },
  spriteSheet: '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true"><symbol id="workspace-file-agents" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m7 8 3 4-3 4m6 0h4"/></g></symbol></svg>',
};
const EMPTY_ENTRIES: FileNode[] = [];

// Theme variables cross the vendor's shadow boundary; no app CSS classes.
const TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-fg-override: var(--t-text);
    --trees-fg-muted-override: var(--t-text-muted);
    --trees-selected-bg-override: var(--t-input-bg);
    --trees-hover-bg-override: var(--t-hover);
    --trees-border-color-override: var(--t-divider-subtle);
    --trees-status-ignored-override: var(--t-text-faint);
    --trees-font-family-override: var(--font-sans-system);
    --trees-font-size-override: 12px;
    font-weight: 300;
  }
  button[data-type='item'] { border-radius: 5px; }
  [data-item-git-status='ignored'] svg { opacity: .5; }
  [data-file-tree-virtualized-scroll='true'], [data-file-tree-scrollbar-measure='true'] { scrollbar-width: none !important; scrollbar-gutter: auto !important; }
  [data-file-tree-virtualized-scroll='true']::-webkit-scrollbar, [data-file-tree-scrollbar-measure='true']::-webkit-scrollbar { display: none; }
`;

function selectionInRepo(repoPath: string | null | undefined, file: string | null) {
  if (!repoPath || !file) return null;
  const prefix = `${repoPath.replace(/\/$/, '')}/`;
  const relative = file.startsWith(prefix) ? file.slice(prefix.length) : file;
  if (relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return relative;
}

function loadedEntries(directories: Record<string, DirectoryState>) {
  const entries: FileNode[] = [];
  const visit = (directory: string) => {
    for (const entry of directories[directory]?.entries ?? []) {
      entries.push(entry);
      if (entry.type === 'dir') visit(entry.path);
    }
  };
  visit('.');
  return entries;
}

function pathChanges(previous: readonly string[], next: readonly string[]): FileTreeBatchOperation[] {
  const old = new Set(previous); const current = new Set(next);
  const removedDirectories: string[] = [];
  const changes: FileTreeBatchOperation[] = [];
  for (const path of previous.filter(path => !current.has(path)).sort((a, b) => a.split('/').length - b.split('/').length)) {
    if (removedDirectories.some(directory => path.startsWith(directory))) continue;
    const directory = path.endsWith('/');
    changes.push({ type: 'remove', path, ...(directory ? { recursive: true } : {}) });
    if (directory) removedDirectories.push(path);
  }
  for (const path of next) if (!old.has(path)) changes.push({ type: 'add', path });
  return changes;
}

function treePaths(entries: readonly FileNode[]) {
  const paths = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split('/');
    // Search matches include files only. Track their folders too so returning
    // to browsing does not re-add ancestors retained by the tree engine.
    for (let index = 1; index < segments.length; index++) paths.add(`${segments.slice(0, index).join('/')}/`);
    paths.add(entry.type === 'dir' ? `${entry.path}/` : entry.path);
  }
  return [...paths];
}

function ToolButton({ label, disabled = false, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
    style={{ width: 26, height: 26, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: 6, padding: 0, background: 'transparent', color: 'var(--t-text-muted)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? .45 : 1 }}
    onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-hover)'; }}
    onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }}>{children}</button>;
}

export default function WorkspaceFileTree({ repoPath, selectedFile, dirtyFiles, onSelectFile }: WorkspaceFileTreeProps) {
  const { workspaceGlass, paletteId } = useTheme();
  const { directories, loadDirectory } = useWorkspaceFiles(repoPath);
  const root = directories['.'];
  const [query, setQuery] = useState('');
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [searchResult, setSearchResult] = useState<{ query: string; entries: FileNode[]; error: boolean; truncated: boolean } | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  const handlers = useRef({ onSelectFile, entries: new Map<string, FileNode>(), syncing: false });
  const previousPaths = useRef<readonly string[]>([]);
  const pendingReveal = useRef<string | null>(null);
  const handledSelection = useRef<string | null>(null);
  const expandState = useRef({ all: false, expanded: new Set<string>() });
  const selection = selectionInRepo(repoPath, selectedFile);
  const browsingEntries = useMemo(() => loadedEntries(directories), [directories]);
  const searching = Boolean(query.trim());
  const matchingResult = searchResult?.query === query.trim() ? searchResult : null;
  const entries = searching ? matchingResult?.entries ?? EMPTY_ENTRIES : browsingEntries;
  const paths = useMemo(() => treePaths(entries), [entries]);
  const directoryPaths = useMemo(() => browsingEntries.filter(entry => entry.type === 'dir').map(entry => `${entry.path}/`), [browsingEntries]);
  const { model } = useFileTree({
    paths: [], density: 'compact', initialExpansion: 'closed', flattenEmptyDirectories: true,
    initialVisibleRowCount: 80, icons: TREE_ICONS, unsafeCSS: TREE_CSS,
    search: false, fileTreeSearchMode: 'hide-non-matches', dragAndDrop: false,
    onSelectionChange(selected) {
      if (handlers.current.syncing) return;
      const path = selected.at(-1);
      if (path && !path.endsWith('/') && handlers.current.entries.get(path)?.type === 'file') handlers.current.onSelectFile(path);
    },
  });
  const expanded = useFileTreeSelector(model, current => directoryPaths.filter(path => {
    const item = current.getItem(path);
    return item?.isDirectory() && 'isExpanded' in item && item.isExpanded();
  }), (a, b) => a.length === b.length && a.every((path, i) => path === b[i]));
  useEffect(() => {
    const observe = () => {
      const current = new Set(directoryPaths.filter(path => {
        const item = model.getItem(path);
        return item?.isDirectory() && 'isExpanded' in item && item.isExpanded();
      }));
      if (expandState.current.all && [...expandState.current.expanded].some(path => !current.has(path))) {
        expandState.current.all = false;
        setExpandAll(false);
      }
      expandState.current.expanded = current;
    };
    return model.subscribe(observe);
  }, [directoryPaths, model]);

  useEffect(() => {
    handlers.current.onSelectFile = onSelectFile;
    handlers.current.entries = new Map(entries.map(entry => [entry.path, entry]));
    const changes = pathChanges(previousPaths.current, paths);
    previousPaths.current = paths;
    handlers.current.syncing = true;
    try {
      if (changes.length) model.batch(changes);
      model.setGitStatus(entries.flatMap<GitStatusEntry>(entry => entry.ignored ? [{ path: entry.type === 'dir' ? `${entry.path}/` : entry.path, status: 'ignored' as const }]
        : dirtyFiles.has(entry.path) ? [{ path: entry.path, status: 'modified' as const }] : []));
      model.setSearch(searching && matchingResult ? query.trim() : null);
    } finally { handlers.current.syncing = false; }
  }, [dirtyFiles, entries, matchingResult, model, onSelectFile, paths, query, searching]);

  useEffect(() => {
    if (searching) return;
    const available = Math.max(0, 4 - Object.values(directories).filter(directory => directory.loading).length);
    for (const path of expanded.filter(path => !directories[path.slice(0, -1)]).slice(0, available)) void loadDirectory(path.slice(0, -1));
  }, [directories, expanded, loadDirectory, searching]);
  useEffect(() => {
    if (!expandAll || searching) return;
    for (const entry of browsingEntries) {
      if (entry.type !== 'dir' || entry.ignored) continue;
      const item = model.getItem(`${entry.path}/`);
      if (item?.isDirectory() && 'isExpanded' in item && !item.isExpanded()) item.expand();
    }
  }, [browsingEntries, expandAll, model, searching]);

  useEffect(() => {
    const controller = new AbortController();
    if (!repoPath || !query.trim()) return () => controller.abort();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ workspace: repoPath, search: query.trim() });
      void fetch(`/api/panel/files?${params}`, { signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error('Search failed');
        const result = await response.json() as { entries: Array<{ name: string; path: string }>; truncated?: boolean };
        if (!controller.signal.aborted) setSearchResult({ query: query.trim(), entries: result.entries.map(entry => ({ ...entry, type: 'file' })), error: false, truncated: Boolean(result.truncated) });
      }).catch(() => {
        if (!controller.signal.aborted) setSearchResult({ query: query.trim(), entries: [], error: true, truncated: false });
      });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, repoPath, searchAttempt]);

  useEffect(() => {
    if (selection === handledSelection.current) return;
    pendingReveal.current = selection;
  }, [selection]);
  useEffect(() => {
    if (!pendingReveal.current || !selection || searching || !root || root.loading || root.error) return;
    const parts = selection.split('/');
    let siblings = root.entries;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const path = parts.slice(0, index + 1).join('/');
      if (!siblings.some(entry => entry.path === path && entry.type === 'dir')) return;
      const item = model.getItem(`${path}/`);
      if (item?.isDirectory() && 'expand' in item) item.expand();
      const directory = directories[path];
      if (!directory) { void loadDirectory(path); return; }
      if (directory.loading || directory.error) return;
      siblings = directory.entries;
    }
    if (!siblings.some(entry => entry.path === selection && entry.type === 'file')) return;
    const item = model.getItem(selection);
    if (!item) return;
    handlers.current.syncing = true;
    try {
      for (const path of model.getSelectedPaths()) if (path !== selection) model.getItem(path)?.deselect();
      item.select();
      model.scrollToPath(selection, { focus: false, offset: 'nearest' });
    } finally { handlers.current.syncing = false; }
    pendingReveal.current = null;
    handledSelection.current = selection;
  }, [directories, loadDirectory, model, paths, root, searching, selection]);

  const failedFolders = expanded.filter(path => directories[path.slice(0, -1)]?.error);
  const refresh = () => {
    void loadDirectory('.', true);
    for (const path of expanded) void loadDirectory(path.slice(0, -1), true);
    if (searching) { setSearchResult(null); setSearchAttempt(current => current + 1); }
  };
  const toggleExpanded = () => {
    const opening = !expandAll && expanded.length === 0;
    expandState.current.all = opening;
    setExpandAll(opening);
    if (!opening) for (const path of directoryPaths) {
      const item = model.getItem(path); if (item?.isDirectory() && 'collapse' in item) item.collapse();
    }
  };
  const messageStyle: CSSProperties = { paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12, color: 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 12 };

  return <div data-workspace-file-tree style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0, flexDirection: 'column', overflow: 'hidden' }}>
    <div style={{ height: 40, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, paddingLeft: 7, paddingRight: 7 }}>
      <ToolButton label="Refresh file tree" disabled={!repoPath || root?.loading} onClick={refresh}><svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3a7 7 0 0 0 11.5-1" /></svg></ToolButton>
      <input aria-label="Search files" placeholder="Search files" title={repoPath ?? 'Select a repo to browse files'} disabled={!repoPath} value={query} onChange={event => { setQuery(event.target.value); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setQuery(''); } }}
        style={{ width: '100%', minWidth: 0, height: 28, border: 0, borderRadius: 5, paddingLeft: 6, paddingRight: 6, background: 'transparent', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300 }} />
      {searching ? <ToolButton label="Clear file search" onClick={() => setQuery('')}><svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m6 6 12 12M18 6 6 18" /></svg></ToolButton>
        : <ToolButton label={expandAll || expanded.length ? 'Collapse folders' : 'Expand folders'} disabled={!directoryPaths.length} onClick={toggleExpanded}><svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={expandAll || expanded.length ? 'm8 4 4 4 4-4M8 20l4-4 4 4' : 'm8 8 4-4 4 4M8 16l4 4 4-4'} /></svg></ToolButton>}
    </div>
    {!repoPath ? <div style={messageStyle}>Select a repo to browse files.</div>
      : root?.error ? <div role="status" style={messageStyle}>Couldn&apos;t load workspace files. <button type="button" onClick={() => { void loadDirectory('.', true); }}>Retry</button></div>
        : !root || root.loading && !root.entries.length ? <div role="status" style={messageStyle}>Loading files...</div> : null}
    {searching && !matchingResult ? <div role="status" style={messageStyle}>Searching files...</div> : null}
    {matchingResult?.error ? <div role="status" style={messageStyle}>Couldn&apos;t search files. <button type="button" onClick={() => setSearchAttempt(current => current + 1)}>Retry</button></div> : null}
    {searching && matchingResult && !matchingResult.error && !entries.length ? <div role="status" style={messageStyle}>No matching files.</div> : null}
    <FileTree model={model} aria-label="Workspace files" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', colorScheme: workspaceGlass ? 'dark' : getPalette(paletteId).colorScheme, paddingLeft: 8, paddingRight: 8 }} />
    {failedFolders.map(path => <div key={path} role="status" style={messageStyle}>Couldn&apos;t load this folder. <span>{path.slice(0, -1)}</span> <button type="button" aria-label={`Retry ${path.slice(0, -1)}`} onClick={() => { void loadDirectory(path.slice(0, -1), true); }}>Retry</button></div>)}
    {matchingResult?.truncated ? <div role="status" style={messageStyle}>Showing 500 matches. Refine your search to see more.</div> : null}
  </div>;
}
