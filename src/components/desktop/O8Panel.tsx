'use client';

/**
 * O8Panel — Wide contextual panel with tabs: Changes, Browser, Files.
 *
 * Third state of the right panel morph button (collapsed → review → o8).
 * Modeled after Cursor 3's right panel, adapted for governance.
 */

import { useCallback, useEffect, useState } from 'react';
// O8 panel uses the native dark theme — no LIGHT_CANVAS_VARS override needed

// ── Phosphor Icons (raw SVG, per CLAUDE.md) ──

function IconGitDiff({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v4c0 2 2 4 4 4h1" />
      <path d="M18 15v-4c0-2-2-4-4-4h-1" />
    </svg>
  );
}

function IconGlobeSimple({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function IconFiles({ size = 16, color = '#e2e8f0' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', width: size, height: size, minWidth: size, minHeight: size, flexShrink: 0 }}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
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

const O8_ICON_ACTIVE = '#e2e8f0';
const O8_ICON_INACTIVE = 'rgba(255,255,255,0.35)';

function O8TabButton({ icon, active, onClick, label }: {
  icon: (color: string) => React.ReactNode;
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
        background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
        cursor: 'pointer',
        transition: 'background 120ms ease',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {icon(active ? O8_ICON_ACTIVE : O8_ICON_INACTIVE)}
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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
              color: 'rgba(255,255,255,0.85)',
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
                background: 'var(--t-panel, #1e2028)',
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
                      color: 'rgba(255,255,255,0.85)',
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
                    color: 'rgba(255,255,255,0.85)',
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
                    color: file.status === 'added' ? '#22c55e' : file.status === 'deleted' ? '#ef4444' : 'rgba(255,255,255,0.85)',
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
        <O8TabButton icon={(c) => <IconGitDiff size={16} color={c} />} active={activeTab === 'changes'} onClick={() => setActiveTab('changes')} label="Changes" />
        <O8TabButton icon={(c) => <IconGlobeSimple size={16} color={c} />} active={activeTab === 'browser'} onClick={() => setActiveTab('browser')} label="Browser" />
        <O8TabButton icon={(c) => <IconFiles size={16} color={c} />} active={activeTab === 'files'} onClick={() => setActiveTab('files')} label="Files" />
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
