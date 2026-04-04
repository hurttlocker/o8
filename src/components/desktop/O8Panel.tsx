'use client';

/**
 * O8Panel — Wide contextual panel with tabs: Changes, Browser, Files.
 *
 * Third state of the right panel morph button (collapsed → review → o8).
 * Modeled after Cursor 3's right panel, adapted for governance.
 */

import { useCallback, useEffect, useState } from 'react';
import { LIGHT_CANVAS_VARS } from './canvas-utils';

// ── Phosphor Icons (raw SVG, per CLAUDE.md) ──

function IconGitDiff({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" style={{ display: 'block' }}>
      <path d="M112,152a8,8,0,0,0-8,8v28.69L66.34,151A8,8,0,0,1,64,145.37V95a32,32,0,1,0-16,0v50.38a23.85,23.85,0,0,0,7,17L92.69,200H64a8,8,0,0,0,0,16h48a8,8,0,0,0,8-8V160A8,8,0,0,0,112,152ZM40,64A16,16,0,1,1,56,80,16,16,0,0,1,40,64Zm168,97V110.63a23.85,23.85,0,0,0-7-17L163.31,56H192a8,8,0,0,0,0-16H144a8,8,0,0,0-8,8V96a8,8,0,0,0,16,0V67.31L189.66,105a8,8,0,0,1,2.34,5.66V161a32,32,0,1,0,16,0Zm-8,47a16,16,0,1,1,16-16A16,16,0,0,1,200,208Z" />
    </svg>
  );
}

function IconGlobeSimple({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" style={{ display: 'block' }}>
      <path d="M128,24h0A104,104,0,1,0,232,128,104.12,104.12,0,0,0,128,24Zm87.62,96H175.79C174,83.49,159.94,57.67,148.41,42.4A88.19,88.19,0,0,1,215.63,120ZM96.23,136h63.54c-2.31,41.61-22.23,67.11-31.77,77C118.45,203.1,98.54,177.6,96.23,136Zm0-16C98.54,78.39,118.46,52.89,128,43c9.55,9.93,29.46,35.43,31.77,77Zm11.36-77.6C96.06,57.67,82,83.49,80.21,120H40.37A88.19,88.19,0,0,1,107.59,42.4ZM40.37,136H80.21c1.82,36.51,15.85,62.33,27.38,77.6A88.19,88.19,0,0,1,40.37,136Zm108,77.6c11.53-15.27,25.56-41.09,27.38-77.6h39.84A88.19,88.19,0,0,1,148.41,213.6Z" />
    </svg>
  );
}

function IconFiles({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" style={{ display: 'block' }}>
      <path d="M213.66,66.34l-40-40A8,8,0,0,0,168,24H88A16,16,0,0,0,72,40V56H56A16,16,0,0,0,40,72V216a16,16,0,0,0,16,16H168a16,16,0,0,0,16-16V200h16a16,16,0,0,0,16-16V72A8,8,0,0,0,213.66,66.34ZM168,216H56V72h76.69L168,107.31v84.53c0,.06,0,.11,0,.16s0,.1,0,.16V216Zm32-32H184V104a8,8,0,0,0-2.34-5.66l-40-40A8,8,0,0,0,136,56H88V40h76.69L200,75.31Zm-56-32a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h48A8,8,0,0,1,144,152Zm0,32a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h48A8,8,0,0,1,144,184Z" />
    </svg>
  );
}

// ── Types ──

type O8Tab = 'changes' | 'browser' | 'files';

interface GitChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  staged: boolean;
}

type ChangeFilter = 'uncommitted' | 'staged' | 'unstaged' | 'branch';

interface O8PanelProps {
  onClose: () => void;
  repoPath?: string | null;
}

// ── Tab Button ──

function O8TabButton({ icon, active, onClick, label }: {
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        border: 'none',
        borderRadius: 8,
        background: active ? 'var(--t-panel-active, rgba(0,0,0,0.06))' : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-faint)',
        cursor: 'pointer',
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--t-hover, rgba(0,0,0,0.04))'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}
    </button>
  );
}

// ── Changes Tab ──

function ChangesTab({ repoPath }: { repoPath?: string | null }) {
  const [files, setFiles] = useState<GitChangedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ChangeFilter>('uncommitted');
  const [filterOpen, setFilterOpen] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);

  const filterLabel: Record<ChangeFilter, string> = {
    uncommitted: 'Uncommitted',
    staged: 'Staged',
    unstaged: 'Unstaged',
    branch: 'Branch Changes',
  };

  const fetchChanges = useCallback(async () => {
    if (!repoPath) { setFiles([]); setLoading(false); return; }
    setLoading(true);
    try {
      const wsParam = encodeURIComponent(repoPath);
      const res = await fetch(`/api/panel/git-status?workspace=${wsParam}&filter=${filter}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFiles(data.files ?? []);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [repoPath, filter]);

  useEffect(() => { void fetchChanges(); }, [fetchChanges]);

  const handleFileClick = useCallback(async (filePath: string) => {
    if (expandedFile === filePath) {
      setExpandedFile(null);
      setExpandedDiff(null);
      return;
    }
    setExpandedFile(filePath);
    setExpandedDiff(null);
    if (!repoPath) return;
    try {
      const wsParam = encodeURIComponent(repoPath);
      const pathParam = encodeURIComponent(filePath);
      const res = await fetch(`/api/panel/file-diff?path=${pathParam}&workspace=${wsParam}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setExpandedDiff(data.diff || data.stagedDiff || 'No diff available');
    } catch {
      setExpandedDiff('Failed to load diff');
    }
  }, [expandedFile, repoPath]);

  const totalAdditions = files.reduce((sum, f) => sum + (f.additions || 0), 0);
  const totalDeletions = files.reduce((sum, f) => sum + (f.deletions || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', ...LIGHT_CANVAS_VARS }}>
      {/* Filter bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 12,
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setFilterOpen(v => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: 4,
              paddingRight: 10,
              paddingBottom: 4,
              paddingLeft: 10,
              borderRadius: 6,
              border: '1px solid var(--t-divider)',
              background: 'transparent',
              color: 'var(--t-text)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            {files.length > 0 ? `${files.length} ${filterLabel[filter]}` : `No ${filterLabel[filter]} Changes`}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {filterOpen ? (
            <>
              <div onClick={() => setFilterOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 99 }} />
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: 4,
                minWidth: 160,
                padding: 4,
                borderRadius: 10,
                border: '1px solid var(--t-divider)',
                background: 'var(--t-panel, #fff)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                zIndex: 100,
              }}>
                {(['uncommitted', 'staged', 'unstaged', 'branch'] as ChangeFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => { setFilter(f); setFilterOpen(false); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      padding: '7px 10px',
                      border: 'none',
                      borderRadius: 6,
                      background: filter === f ? 'var(--t-accent-soft, rgba(37,99,235,0.08))' : 'transparent',
                      color: 'var(--t-text)',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                    }}
                    onMouseEnter={(e) => { if (filter !== f) e.currentTarget.style.background = 'var(--t-hover, rgba(0,0,0,0.04))'; }}
                    onMouseLeave={(e) => { if (filter !== f) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {filterLabel[f]}
                    {filter === f ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : null}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        {files.length > 0 ? (
          <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
            <span style={{ color: '#22c55e' }}>+{totalAdditions}</span>
            {' '}
            <span style={{ color: '#ef4444' }}>-{totalDeletions}</span>
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void fetchChanges()}
          title="Refresh"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover, rgba(0,0,0,0.04))'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 24, color: 'var(--t-text-muted)', fontSize: 13, textAlign: 'center' }}>Loading...</div>
        ) : files.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--t-text-faint)', fontSize: 13, textAlign: 'center' }}>
            No {filterLabel[filter].toLowerCase()} changes
          </div>
        ) : (
          files.map((file) => {
            const isExpanded = expandedFile === file.path;
            return (
              <div key={file.path}>
                <button
                  type="button"
                  onClick={() => void handleFileClick(file.path)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    paddingTop: 6,
                    paddingRight: 12,
                    paddingBottom: 6,
                    paddingLeft: 12,
                    border: 'none',
                    background: isExpanded ? 'var(--t-accent-soft, rgba(37,99,235,0.06))' : 'transparent',
                    color: 'var(--t-text)',
                    fontSize: 12,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    cursor: 'pointer',
                    textAlign: 'left',
                    borderBottom: '1px solid var(--t-divider-subtle)',
                  }}
                  onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = 'var(--t-hover, rgba(0,0,0,0.03))'; }}
                  onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms ease' }}>
                    <polyline points="9 6 15 12 9 18" />
                  </svg>
                  <span style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: file.status === 'added' ? '#22c55e' : file.status === 'deleted' ? '#ef4444' : 'var(--t-text)',
                  }}>
                    {file.path}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
                    {file.additions > 0 ? <span style={{ color: '#22c55e' }}>+{file.additions}</span> : null}
                    {file.additions > 0 && file.deletions > 0 ? ' ' : null}
                    {file.deletions > 0 ? <span style={{ color: '#ef4444' }}>-{file.deletions}</span> : null}
                  </span>
                </button>
                {isExpanded && expandedDiff ? (
                  <div style={{
                    paddingTop: 0,
                    paddingRight: 0,
                    paddingBottom: 0,
                    paddingLeft: 0,
                    borderBottom: '1px solid var(--t-divider)',
                    maxHeight: 400,
                    overflow: 'auto',
                  }}>
                    <pre style={{
                      margin: 0,
                      fontSize: 11,
                      lineHeight: 1.6,
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}>
                      {expandedDiff.split('\n').map((line, i) => {
                        const isAdd = line.startsWith('+') && !line.startsWith('+++');
                        const isDel = line.startsWith('-') && !line.startsWith('---');
                        const isHunk = line.startsWith('@@');
                        return (
                          <div
                            key={i}
                            style={{
                              paddingTop: 0,
                              paddingRight: 12,
                              paddingBottom: 0,
                              paddingLeft: 12,
                              background: isAdd ? 'rgba(34,197,94,0.10)' : isDel ? 'rgba(239,68,68,0.08)' : isHunk ? 'rgba(37,99,235,0.06)' : 'transparent',
                              color: isAdd ? '#15803d' : isDel ? '#b91c1c' : isHunk ? '#2563eb' : 'var(--t-text-secondary)',
                              minHeight: 20,
                              display: 'flex',
                              alignItems: 'center',
                            }}
                          >
                            {line || '\u00A0'}
                          </div>
                        );
                      })}
                    </pre>
                  </div>
                ) : isExpanded ? (
                  <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--t-text-muted)', borderBottom: '1px solid var(--t-divider)' }}>
                    Loading diff...
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Main Component ──

export function O8Panel({ onClose, repoPath }: O8PanelProps) {
  const [activeTab, setActiveTab] = useState<O8Tab>('changes');

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--t-bg)',
      borderLeft: '1px solid var(--t-divider)',
    }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        height: 40,
        paddingLeft: 8,
        paddingRight: 8,
        borderBottom: '1px solid var(--t-divider)',
        flexShrink: 0,
        gap: 2,
      }}>
        <O8TabButton icon={<IconGitDiff size={16} />} active={activeTab === 'changes'} onClick={() => setActiveTab('changes')} label="Changes" />
        <O8TabButton icon={<IconGlobeSimple size={16} />} active={activeTab === 'browser'} onClick={() => setActiveTab('browser')} label="Browser" />
        <O8TabButton icon={<IconFiles size={16} />} active={activeTab === 'files'} onClick={() => setActiveTab('files')} label="Files" />
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onClose}
          title="Close panel"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            cursor: 'pointer',
            transition: 'background 120ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'changes' ? (
          <ChangesTab repoPath={repoPath} />
        ) : activeTab === 'browser' ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-faint)', fontSize: 13 }}>
            Browser — coming soon
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-faint)', fontSize: 13 }}>
            Files — coming soon
          </div>
        )}
      </div>
    </div>
  );
}
