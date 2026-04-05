'use client';

/**
 * O8FilesPane — Split file browser for the O8 panel Files tab.
 *
 * Left: expandable directory tree (from /api/panel/files).
 * Right: file content viewer (from /api/v2/files).
 * Cursor-inspired layout with our existing dark theme.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ── Types ──

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

interface O8FilesPaneProps {
  repoPath?: string;
  onOpenFile?: (filePath: string) => void;
}

// ── Icons (raw SVG) ──

function ChevronIcon({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', transition: 'transform 120ms ease', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
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
  if (open) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        <line x1="2" y1="10" x2="22" y2="10" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// ── File extension color mapping ──

function extensionColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts': case 'tsx': return '#3b82f6';
    case 'js': case 'jsx': return '#eab308';
    case 'json': return '#f97316';
    case 'md': case 'mdx': return '#8b5cf6';
    case 'css': case 'scss': return '#ec4899';
    case 'html': return '#ef4444';
    case 'rs': return '#f97316';
    case 'toml': case 'yaml': case 'yml': return '#6b7280';
    case 'svg': case 'png': case 'jpg': case 'ico': return '#14b8a6';
    default: return '#9ca3af';
  }
}

// ── Tree Node ──

function TreeNode({
  node,
  depth,
  selectedPath,
  expandedDirs,
  changedFiles,
  onToggleDir,
  onSelectFile,
}: {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  expandedDirs: Set<string>;
  changedFiles: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isDir = node.type === 'dir';
  const isOpen = expandedDirs.has(node.path);
  const isSelected = selectedPath === node.path;
  const isChanged = changedFiles.has(node.path);

  return (
    <>
      <button
        type="button"
        onClick={() => isDir ? onToggleDir(node.path) : onSelectFile(node.path)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          width: '100%',
          height: 26,
          paddingLeft: 8 + depth * 16,
          paddingRight: 8,
          border: 'none',
          borderRadius: 0,
          background: isSelected ? 'rgba(37, 99, 235, 0.12)' : 'transparent',
          color: isDir ? 'var(--t-text)' : extensionColor(node.name),
          cursor: 'pointer',
          fontFamily: '"SF Mono", ui-monospace, monospace',
          fontSize: 12,
          fontWeight: isDir ? 600 : 400,
          textAlign: 'left',
          letterSpacing: '-0.01em',
          transition: 'background 80ms ease',
        }}
        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
      >
        {isDir ? (
          <>
            <ChevronIcon open={isOpen} size={10} />
            <FolderIcon open={isOpen} size={13} />
          </>
        ) : (
          <>
            <span style={{ width: 10 }} />
            <FileIcon size={13} />
          </>
        )}
        <span style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {node.name}
        </span>
        {isChanged ? (
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#22c55e',
            flexShrink: 0,
          }} />
        ) : null}
      </button>
      {isDir && isOpen && node.children ? (
        node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            expandedDirs={expandedDirs}
            changedFiles={changedFiles}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
          />
        ))
      ) : null}
    </>
  );
}

// ── Main Component ──

export function O8FilesPane({ repoPath, onOpenFile }: O8FilesPaneProps) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [repoName, setRepoName] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  // Fetch tree
  useEffect(() => {
    const params = repoPath ? `?workspace=${encodeURIComponent(repoPath)}` : '';
    fetch(`/api/panel/files${params}`)
      .then((r) => r.json())
      .then((data) => {
        setTree(data.tree ?? []);
        setChangedFiles(new Set(data.changedFiles ?? []));
        const root = data.root ?? repoPath ?? '';
        setRepoName(root.split('/').pop() ?? root);
      })
      .catch(() => {});
  }, [repoPath]);

  const handleToggleDir = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  const handleSelectFile = useCallback((filePath: string) => {
    setSelectedPath(filePath);
    setFileLoading(true);
    setFileContent(null);
    const params = new URLSearchParams({ path: filePath });
    if (repoPath) params.set('workspace', repoPath);
    fetch(`/api/v2/files?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setFileContent(data.content ?? null);
        if (contentRef.current) contentRef.current.scrollTop = 0;
      })
      .catch(() => setFileContent(null))
      .finally(() => setFileLoading(false));
  }, [repoPath]);

  return (
    <div style={{
      display: 'flex',
      flex: 1,
      minHeight: 0,
      overflow: 'hidden',
    }}>
      {/* Left — File tree */}
      <div style={{
        width: 260,
        minWidth: 200,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--t-divider-subtle)',
        overflow: 'hidden',
      }}>
        {/* Tree header */}
        <div style={{
          padding: '8px 10px',
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--t-text-faint)',
          letterSpacing: '0.02em',
          fontFamily: '"SF Mono", ui-monospace, monospace',
          borderBottom: '1px solid var(--t-divider-subtle)',
          flexShrink: 0,
        }}>
          {repoName || 'workspace'}
        </div>
        {/* Tree list */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          paddingTop: 2,
          paddingBottom: 2,
        }}>
          {tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedPath}
              expandedDirs={expandedDirs}
              changedFiles={changedFiles}
              onToggleDir={handleToggleDir}
              onSelectFile={handleSelectFile}
            />
          ))}
        </div>
      </div>

      {/* Right — File content viewer */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        overflow: 'hidden',
      }}>
        {selectedPath ? (
          <>
            {/* File header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              borderBottom: '1px solid var(--t-divider-subtle)',
              flexShrink: 0,
            }}>
              <FileIcon size={13} />
              <span style={{
                flex: 1,
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--t-text)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {selectedPath}
              </span>
              {onOpenFile ? (
                <button
                  type="button"
                  onClick={() => onOpenFile(selectedPath)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 8px',
                    borderRadius: 6,
                    border: '1px solid var(--t-divider)',
                    background: 'transparent',
                    color: 'var(--t-text-secondary)',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  Open
                </button>
              ) : null}
            </div>
            {/* File content */}
            <div
              ref={contentRef}
              style={{
                flex: 1,
                overflowY: 'auto',
                overflowX: 'auto',
                padding: '8px 0',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                fontSize: 12,
                lineHeight: 1.6,
                color: 'var(--t-text)',
                whiteSpace: 'pre',
                tabSize: 2,
              }}
            >
              {fileLoading ? (
                <div style={{ padding: '12px 16px', color: 'var(--t-text-faint)', fontSize: 12 }}>Loading...</div>
              ) : fileContent !== null ? (
                fileContent.split('\n').map((line, i) => (
                  <div key={i} style={{ display: 'flex', minHeight: 20 }}>
                    <span style={{
                      width: 48,
                      textAlign: 'right',
                      paddingRight: 12,
                      color: 'var(--t-text-faint)',
                      userSelect: 'none',
                      flexShrink: 0,
                      fontSize: 11,
                    }}>
                      {i + 1}
                    </span>
                    <span style={{ flex: 1, paddingRight: 16 }}>{line || '\u200b'}</span>
                  </div>
                ))
              ) : (
                <div style={{ padding: '12px 16px', color: 'var(--t-text-faint)', fontSize: 12 }}>Unable to read file</div>
              )}
            </div>
          </>
        ) : (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 12,
            color: 'var(--t-text-faint)',
          }}>
            <FileIcon size={32} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>Select a file to view</span>
          </div>
        )}
      </div>
    </div>
  );
}
