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
  const [editContent, setEditContent] = useState<string>('');
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [repoName, setRepoName] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumberRef = useRef<HTMLDivElement>(null);

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
    setEditContent('');
    setIsDirty(false);
    const params = new URLSearchParams({ path: filePath });
    if (repoPath) params.set('workspace', repoPath);
    fetch(`/api/v2/files?${params}`)
      .then((r) => r.json())
      .then((data) => {
        const content = data.content ?? '';
        setFileContent(content);
        setEditContent(content);
      })
      .catch(() => setFileContent(null))
      .finally(() => setFileLoading(false));
  }, [repoPath]);

  const handleSave = useCallback(async () => {
    if (!selectedPath || !isDirty) return;
    setSaving(true);
    try {
      await fetch('/api/v2/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedPath, content: editContent, workspace: repoPath }),
      });
      setFileContent(editContent);
      setIsDirty(false);
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }, [selectedPath, editContent, isDirty, repoPath]);

  // Cmd+S to save
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && isDirty && selectedPath) {
        e.preventDefault();
        void handleSave();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave, isDirty, selectedPath]);

  // Sync scroll between line numbers and textarea
  const handleEditorScroll = useCallback(() => {
    if (textareaRef.current && lineNumberRef.current) {
      lineNumberRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

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
            {/* Breadcrumb path bar */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '5px 12px',
              borderBottom: '1px solid var(--t-divider-subtle)',
              flexShrink: 0,
              overflow: 'hidden',
            }}>
              {selectedPath.split('/').map((segment, i, arr) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  {i > 0 ? (
                    <span style={{ color: 'var(--t-text-faint)', fontSize: 10 }}>&gt;</span>
                  ) : null}
                  <span style={{
                    fontSize: 12,
                    fontWeight: i === arr.length - 1 ? 600 : 400,
                    color: i === arr.length - 1 ? 'var(--t-text)' : 'var(--t-text-secondary)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}>
                    {segment}
                  </span>
                </span>
              ))}
              <div style={{ flex: 1 }} />
              {isDirty ? (
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 10px',
                    borderRadius: 6,
                    border: 'none',
                    background: '#2563eb',
                    color: '#ffffff',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: saving ? 'wait' : 'pointer',
                    flexShrink: 0,
                    opacity: saving ? 0.7 : 1,
                  }}
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              ) : null}
              {isDirty ? (
                <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 600, flexShrink: 0 }}>Modified</span>
              ) : null}
            </div>
            {/* Editor area — textarea with line numbers */}
            <div style={{
              flex: 1,
              display: 'flex',
              overflow: 'hidden',
              position: 'relative',
            }}>
              {fileLoading ? (
                <div style={{ padding: '12px 16px', color: 'var(--t-text-faint)', fontSize: 12 }}>Loading...</div>
              ) : fileContent !== null ? (
                <>
                  {/* Line numbers gutter */}
                  <div
                    ref={lineNumberRef}
                    style={{
                      width: 48,
                      flexShrink: 0,
                      overflowY: 'hidden',
                      overflowX: 'hidden',
                      paddingTop: 8,
                      paddingBottom: 8,
                      background: 'var(--t-bg-subtle)',
                      borderRight: '1px solid var(--t-divider-subtle)',
                      userSelect: 'none',
                    }}
                  >
                    {editContent.split('\n').map((_, i) => (
                      <div key={i} style={{
                        height: 20,
                        lineHeight: '20px',
                        textAlign: 'right',
                        paddingRight: 8,
                        fontSize: 11,
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        color: 'var(--t-text-faint)',
                      }}>
                        {i + 1}
                      </div>
                    ))}
                  </div>
                  {/* Textarea editor */}
                  <textarea
                    ref={textareaRef}
                    value={editContent}
                    onChange={(e) => {
                      setEditContent(e.target.value);
                      setIsDirty(e.target.value !== fileContent);
                    }}
                    onScroll={handleEditorScroll}
                    spellCheck={false}
                    style={{
                      flex: 1,
                      resize: 'none',
                      border: 'none',
                      outline: 'none',
                      background: 'transparent',
                      color: 'var(--t-text)',
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                      fontSize: 12,
                      lineHeight: '20px',
                      paddingTop: 8,
                      paddingBottom: 8,
                      paddingLeft: 12,
                      paddingRight: 16,
                      whiteSpace: 'pre',
                      tabSize: 2,
                      overflowX: 'auto',
                      overflowY: 'auto',
                    }}
                    onKeyDown={(e) => {
                      // Tab inserts 2 spaces instead of changing focus
                      if (e.key === 'Tab') {
                        e.preventDefault();
                        const ta = e.currentTarget;
                        const start = ta.selectionStart;
                        const end = ta.selectionEnd;
                        const value = ta.value;
                        const newValue = value.substring(0, start) + '  ' + value.substring(end);
                        setEditContent(newValue);
                        setIsDirty(newValue !== fileContent);
                        requestAnimationFrame(() => {
                          ta.selectionStart = start + 2;
                          ta.selectionEnd = start + 2;
                        });
                      }
                    }}
                  />
                </>
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
            <span style={{ fontSize: 11, color: 'var(--t-text-faint)' }}>Cmd+S to save changes</span>
          </div>
        )}
      </div>
    </div>
  );
}
