'use client';

/**
 * DiffModal — glass modal showing workspace diff review.
 *
 * Shows changed files list + inline diff preview.
 * Glass frost aesthetic matching mermaid modal.
 */

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, FileText, FilePlus, FileMinus, FileEdit, X } from 'lucide-react';
import { useSharedDesktopWs } from './hooks/DesktopWebSocketContext';
import { measureHeight } from '@/lib/pretext';

interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number | null;
  deletions: number | null;
}

interface FileDetail {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  preview: string;
  note?: string;
  commitSummary?: string;
  commitAuthor?: string;
  commitAge?: string;
}

interface DiffModalProps {
  onClose: () => void;
}

const statusColors: Record<string, string> = {
  added: '#22c55e',
  modified: '#f59e0b',
  deleted: '#ef4444',
  renamed: '#8b5cf6',
  untracked: '#6b7280',
};

const StatusIcon = ({ status }: { status: string }) => {
  const color = statusColors[status] ?? '#6b7280';
  const size = 15;
  switch (status) {
    case 'added': return <FilePlus size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    case 'deleted': return <FileMinus size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    case 'modified': return <FileEdit size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    default: return <FileText size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
  }
};

export const DiffModal = memo(function DiffModal({ onClose }: DiffModalProps) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDetail, setFileDetail] = useState<FileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  // [pretext] Track diff preview pane width for zero-reflow line height measurement.
  const [diffPaneWidth, setDiffPaneWidth] = useState(0);
  const diffPaneObserverRef = useRef<ResizeObserver | null>(null);

  const diffPaneRefCallback = useCallback((node: HTMLDivElement | null) => {
    if (diffPaneObserverRef.current) {
      diffPaneObserverRef.current.disconnect();
      diffPaneObserverRef.current = null;
    }
    if (node) {
      setDiffPaneWidth(node.clientWidth);
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
          setDiffPaneWidth(w);
        }
      });
      observer.observe(node);
      diffPaneObserverRef.current = observer;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (diffPaneObserverRef.current) {
        diffPaneObserverRef.current.disconnect();
      }
    };
  }, []);

  const loadWorkspace = useCallback(async () => {
    try {
      const res = await fetch('/api/review/workspace');
      if (!res.ok) return;
      const data = await res.json();
      setFiles(data.changedFiles ?? []);
    } catch {
      // silent
    }
  }, []);

  // Escape to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Load workspace snapshot
  useEffect(() => {
    async function load() {
      try {
        await loadWorkspace();
      } catch { /* silent */ }
      finally { setLoading(false); }
    }
    void load();
  }, [loadWorkspace]);

  // Load file detail
  const selectFile = useCallback(async (path: string) => {
    setSelectedFile(path);
    setDetailLoading(true);
    setFileDetail(null);
    try {
      const res = await fetch(`/api/review/file?path=${encodeURIComponent(path)}`);
      if (!res.ok) return;
      const data = await res.json();
      setFileDetail(data.file ?? null);
    } catch { /* silent */ }
    finally { setDetailLoading(false); }
  }, []);

  useSharedDesktopWs(undefined, {
    onReviewUpdate: (data) => {
      if ((data.event as string | undefined) !== 'file-changes') return;
      void loadWorkspace();
      if (selectedFile) {
        void selectFile(selectedFile);
      }
    },
  });

  const totalAdditions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--cortex-dialog-overlay-padding)',
        boxSizing: 'border-box',
        backdropFilter: 'blur(40px) saturate(200%) brightness(1.05)',
        WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.05)',
        backgroundColor: 'var(--t-panel-translucent)',
        animation: 'fadeIn 200ms ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: 'min(1400px, calc(100vw - (var(--cortex-dialog-overlay-padding) * 2)))',
          height: 'min(88vh, calc(100vh - (var(--cortex-dialog-overlay-padding) * 2)))',
          maxWidth: 1400,
          borderRadius: 20,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--t-panel-translucent)',
          border: '1px solid var(--t-panel-border)',
          boxShadow: 'var(--t-panel-shadow)',
          backdropFilter: 'blur(60px) saturate(180%)',
          WebkitBackdropFilter: 'blur(60px) saturate(180%)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--cortex-dialog-header-padding)',
          borderBottom: '1px solid var(--t-divider)',
          background: 'var(--t-panel-translucent)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--t-text)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}>
              Workspace Diff
            </span>
            <span style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#22c55e',
            }}>+{totalAdditions}</span>
            <span style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#ef4444',
            }}>-{totalDeletions}</span>
            <span style={{
              fontSize: 12,
              color: 'var(--t-text-secondary)',
            }}>{files.length} file{files.length !== 1 ? 's' : ''}</span>
          </div>

          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              borderRadius: 8,
              border: '1px solid var(--t-divider)',
              background: 'var(--t-panel-translucent)',
              color: '#ef4444',
              cursor: 'pointer',
              paddingTop: 0,
              paddingRight: 0,
              paddingBottom: 0,
              paddingLeft: 0,
            }}
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        {/* Body: file list + diff preview */}
        <div style={{
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
        }}>
          {/* File list sidebar */}
          <div style={{
            width: 280,
            flexShrink: 0,
            borderRight: '1px solid var(--t-divider)',
            overflowY: 'auto',
            background: 'var(--t-panel-translucent)',
          }}>
            {loading ? (
              <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>Loading…</div>
            ) : files.length === 0 ? (
              <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>Working tree clean</div>
            ) : (
              files.map((file) => {
                const isActive = selectedFile === file.path;
                const fileName = file.path.split('/').pop() ?? file.path;
                const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => void selectFile(file.path)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      paddingTop: 10,
                      paddingRight: 12,
                      paddingBottom: 10,
                      paddingLeft: 14,
                      border: 'none',
                      borderLeft: isActive ? '2px solid #2563eb' : '2px solid transparent',
                      background: isActive ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                      transition: 'all 100ms ease',
                    }}
                  >
                    <StatusIcon status={file.status} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13,
                        fontWeight: isActive ? 600 : 400,
                        color: 'var(--t-text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>{fileName}</div>
                      {dirPath ? (
                        <div style={{
                          fontSize: 11,
                          color: 'var(--t-text-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>{dirPath}</div>
                      ) : null}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
                      {(file.additions ?? 0) > 0 ? (
                        <span style={{ color: '#22c55e' }}>+{file.additions}</span>
                      ) : null}
                      {(file.deletions ?? 0) > 0 ? (
                        <span style={{ color: '#ef4444' }}>-{file.deletions}</span>
                      ) : null}
                    </div>
                    <ChevronRight size={12} strokeWidth={2} style={{ color: 'var(--t-text-faint)', flexShrink: 0 }} />
                  </button>
                );
              })
            )}
          </div>

          {/* Diff preview — ref tracked for Pretext width measurement */}
          <div ref={diffPaneRefCallback} style={{
            flex: 1,
            overflowY: 'auto',
            background: 'transparent',
          }}>
            {!selectedFile ? (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                fontSize: 14,
                color: 'var(--t-text-muted)',
              }}>
                Select a file to see the diff
              </div>
            ) : detailLoading ? (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                fontSize: 13,
                color: 'var(--t-text-muted)',
              }}>
                Loading diff…
              </div>
            ) : fileDetail ? (
              <div>
                {/* File header */}
                <div style={{
                  paddingTop: 12,
                  paddingRight: 16,
                  paddingBottom: 12,
                  paddingLeft: 16,
                  borderBottom: '1px solid var(--t-divider)',
                  background: 'var(--t-panel-translucent)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}>
                  <StatusIcon status={fileDetail.status} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)' }}>{fileDetail.path}</span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, fontSize: 11, fontWeight: 600 }}>
                    <span style={{ color: '#22c55e' }}>+{fileDetail.additions ?? 0}</span>
                    <span style={{ color: '#ef4444' }}>-{fileDetail.deletions ?? 0}</span>
                  </div>
                </div>
                {fileDetail.commitSummary ? (
                  <div style={{
                    paddingTop: 8,
                    paddingRight: 16,
                    paddingBottom: 8,
                    paddingLeft: 16,
                    borderBottom: '1px solid var(--t-divider-subtle)',
                    fontSize: 12,
                    color: 'var(--t-text-secondary)',
                  }}>
                    {fileDetail.commitSummary} — {fileDetail.commitAuthor} ({fileDetail.commitAge})
                  </div>
                ) : null}
                {/* Diff content — font-size 12px / lineHeight 1.5 matches FONTS['mono'] in pretext engine */}
                <pre style={{
                  margin: 0,
                  paddingTop: 14,
                  paddingRight: 16,
                  paddingBottom: 14,
                  paddingLeft: 16,
                  fontSize: 12,
                  lineHeight: 1.5,
                  fontFamily: '"SF Mono", "Menlo", "Monaco", ui-monospace, monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--t-text)',
                }}>
                  {renderDiffLines(fileDetail.preview, diffPaneWidth > 32 ? diffPaneWidth - 32 : 0)}
                </pre>
              </div>
            ) : (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                fontSize: 13,
                color: '#ef4444',
              }}>
                Could not load file diff
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
});

// [pretext] Render diff lines with +/- coloring and explicit heights when containerWidth is known.
// containerWidth should be the available content width (pre paddingLeft/Right already subtracted by caller).
function renderDiffLines(text: string, containerWidth: number = 0) {
  return text.split('\n').map((line, i) => {
    let color = 'var(--t-text)';
    let bg = 'transparent';

    if (line.startsWith('+') && !line.startsWith('+++')) {
      color = '#166534';
      bg = 'rgba(34, 197, 94, 0.08)';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      color = '#991b1b';
      bg = 'rgba(239, 68, 68, 0.08)';
    } else if (line.startsWith('@@')) {
      color = '#6366f1';
      bg = 'rgba(99, 102, 241, 0.06)';
    } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      color = 'var(--t-text-secondary)';
    }

    // [pretext] Set explicit height to eliminate browser reflow for text measurement.
    const measuredHeight = containerWidth > 0
      ? measureHeight(line || '\u00A0', 'mono', containerWidth, 1.5, 'pre-wrap')
      : 0;
    const rowStyle: React.CSSProperties = measuredHeight > 0
      ? { color, background: bg, paddingTop: 1, paddingBottom: 1, height: measuredHeight, overflow: 'hidden' }
      : { color, background: bg, paddingTop: 1, paddingBottom: 1 };

    return (
      <div key={i} style={rowStyle}>
        {line || '\u00A0'}
      </div>
    );
  });
}
