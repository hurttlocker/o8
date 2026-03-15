'use client';

/**
 * Canvas — Bottom-half contextual workspace with tabs.
 *
 * Responds to selections from AgentPanel:
 *   - Issue selected → opens issue detail tab
 *   - Agent surface clicked → opens live transcript tab
 *   - File selected → opens file viewer tab
 *
 * Tabs persist — you can have multiple open and switch between them.
 * Each tab type renders its own content viewer.
 *
 * Q's spec: bottom half of center, tabbed, replaces modals for primary content.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileEdit,
  FileMinus,
  FilePlus,
  FileText,
  GitCommit,
  MessageSquare,
  Plus,
  Radio,
  Terminal,
  X,
} from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';
import { IssueCreator } from './IssueCreator';

// ── Tab Types ──

export type CanvasTabKind = 'issue' | 'transcript' | 'file' | 'diff' | 'commit' | 'pr' | 'readme' | 'ci' | 'new-issue' | 'git-log' | 'image' | 'welcome';

export interface CanvasTab {
  id: string;
  kind: CanvasTabKind;
  label: string;
  /** Issue number, session key, file path, etc. */
  resourceId: string;
  /** Optional metadata (e.g., repo for scoped issue/PR queries) */
  meta?: Record<string, string>;
}

export interface CanvasProps {
  tabs: CanvasTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onSelectCommit?: (hash: string) => void;
}

// ── Main Canvas ──

export const Canvas = memo(function Canvas({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onSelectCommit,
}: CanvasProps) {
  const activeTab = tabs.find((t) => t.id === activeTabId) || null;

  if (tabs.length === 0) {
    return <CanvasEmpty />;
  }

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: '#f8f9fc',
      borderTop: '1px solid rgba(0,0,0,0.06)',
    }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        height: 36,
        flexShrink: 0,
        background: 'rgba(255,255,255,0.72)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        paddingLeft: 8,
        paddingRight: 8,
        overflowX: 'auto',
        overflowY: 'hidden',
      }}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 28,
                padding: '0 10px',
                marginRight: 2,
                borderRadius: 8,
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? '#1e293b' : '#64748b',
                background: isActive ? 'rgba(255,255,255,0.9)' : 'transparent',
                boxShadow: isActive
                  ? '0 1px 3px rgba(0,0,0,0.06), 0 0 0 0.5px rgba(0,0,0,0.04)'
                  : 'none',
                cursor: 'pointer',
                transition: 'all 150ms ease',
                flexShrink: 0,
                letterSpacing: '-0.01em',
                userSelect: 'none',
              }}
            >
              <TabIcon kind={tab.kind} size={13} />
              <span style={{
                maxWidth: 140,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {tab.label}
              </span>
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  marginLeft: 2,
                  color: '#94a3b8',
                  cursor: 'pointer',
                  transition: 'all 100ms ease',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,0,0,0.06)';
                  (e.currentTarget as HTMLDivElement).style.color = '#ef4444';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                  (e.currentTarget as HTMLDivElement).style.color = '#94a3b8';
                }}
              >
                <X size={11} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={{
        flex: 1,
        overflow: 'auto',
      }}>
        {activeTab ? (
          <TabContent tab={activeTab} onSelectCommit={onSelectCommit} />
        ) : (
          <CanvasEmpty />
        )}
      </div>
    </div>
  );
});

// ── Tab Icon ──

function TabIcon({ kind, size = 14 }: { kind: CanvasTabKind; size?: number }) {
  switch (kind) {
    case 'issue': return <AlertCircle size={size} />;
    case 'transcript': return <Terminal size={size} />;
    case 'file': return <FileText size={size} />;
    case 'diff': return <GitCommit size={size} />;
    case 'commit': return <GitCommit size={size} />;
    case 'pr': return <GitCommit size={size} />;
    case 'readme': return <BookOpen size={size} />;
    case 'ci': return <AlertCircle size={size} />;
    case 'new-issue': return <Plus size={size} />;
    case 'git-log': return <GitCommit size={size} />;
    case 'image': return <FileText size={size} />;
    case 'welcome': return <BookOpen size={size} />;
  }
}

// ── Tab Content Router ──

const TabContent = memo(function TabContent({ tab, onSelectCommit }: { tab: CanvasTab; onSelectCommit?: (hash: string) => void }) {
  switch (tab.kind) {
    case 'issue':
      return <IssueViewer issueNumber={parseInt(tab.resourceId, 10)} repo={tab.meta?.repo} />;
    case 'transcript':
      return <TranscriptViewer sessionKey={tab.resourceId} />;
    case 'file':
      return <FileViewer filePath={tab.resourceId} workspace={tab.meta?.workspace} />;
    case 'diff':
      return <DiffViewer />;
    case 'commit':
      return <CommitViewer commitHash={tab.resourceId} />;
    case 'pr':
      return <PRViewer prNumber={parseInt(tab.resourceId, 10)} repo={tab.meta?.repo} />;
    case 'readme':
      return <ReadmeViewer workspace={tab.resourceId} />;
    case 'ci':
      return <CIViewer repo={tab.meta?.repo} />;
    case 'new-issue':
      return <IssueCreator repo={tab.meta?.repo} />;
    case 'git-log':
      return <GitLogViewer workspace={tab.resourceId} onSelectCommit={onSelectCommit} />;
    case 'image':
      return <ImagePreview filePath={tab.resourceId} workspace={tab.meta?.workspace} />;
    case 'welcome':
      return <CanvasEmpty />;
    default:
      return <CanvasEmpty />;
  }
});

// ── Issue Viewer ──

interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string; color: string }[];
  author: string;
  createdAt: string;
  comments: number;
  url: string;
}

const IssueViewer = memo(function IssueViewer({ issueNumber, repo }: { issueNumber: number; repo?: string }) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/issues/${issueNumber}${repoParam}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) {
          setDetail(data.issue ?? data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [issueNumber]);

  if (loading) {
    return (
      <div style={{ padding: 32, color: '#94a3b8', fontSize: 13 }}>
        Loading issue #{issueNumber}...
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div style={{ padding: 32, color: '#ef4444', fontSize: 13 }}>
        Failed to load issue #{issueNumber}: {error || 'Unknown error'}
      </div>
    );
  }

  const stateColor = detail.state === 'open' ? '#34c759' : '#8b5cf6';
  const age = formatAge(detail.createdAt);

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        marginBottom: 20,
      }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: stateColor,
          marginTop: 8,
          flexShrink: 0,
        }} />
        <div style={{ flex: 1 }}>
          <h2 style={{
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            color: '#1e293b',
            margin: 0,
            lineHeight: 1.3,
          }}>
            #{detail.number} {detail.title}
          </h2>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginTop: 8,
            fontSize: 12,
            color: '#94a3b8',
          }}>
            <span>{detail.author}</span>
            <span>·</span>
            <span>{age}</span>
            <span>·</span>
            <span>{detail.comments} comment{detail.comments !== 1 ? 's' : ''}</span>
            <a
              href={detail.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                color: '#64748b',
                textDecoration: 'none',
                marginLeft: 'auto',
              }}
            >
              <ExternalLink size={12} />
              GitHub
            </a>
          </div>
          {/* Labels */}
          {detail.labels.length > 0 && (
            <div style={{
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
              marginTop: 10,
            }}>
              {detail.labels.map((l) => (
                <span
                  key={l.name}
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    padding: '2px 8px',
                    borderRadius: 6,
                    backgroundColor: `#${l.color}18`,
                    color: `#${l.color}`,
                    border: `1px solid #${l.color}30`,
                  }}
                >
                  {l.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{
        background: 'rgba(255,255,255,0.8)',
        borderRadius: 14,
        padding: '20px 24px',
        border: '1px solid rgba(0,0,0,0.04)',
        fontSize: 14,
        lineHeight: 1.65,
        color: '#334155',
        letterSpacing: '-0.01em',
      }}>
        <MarkdownBody text={detail.body || '*No description.*'} />
      </div>
    </div>
  );
});

// ── Transcript Viewer ──

const TranscriptViewer = memo(function TranscriptViewer({ sessionKey }: { sessionKey: string }) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=100`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data)) {
          setMessages(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [sessionKey]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (loading) {
    return (
      <div style={{ padding: 32, color: '#94a3b8', fontSize: 13 }}>
        Loading transcript...
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      style={{
        padding: '16px 24px',
        overflowY: 'auto',
        height: '100%',
      }}
    >
      {messages.length === 0 ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 16 }}>
          No messages in this session.
        </div>
      ) : (
        messages.map((msg, i) => (
          <div
            key={i}
            style={{
              marginBottom: 12,
              padding: '10px 14px',
              borderRadius: 12,
              background: msg.role === 'assistant'
                ? 'rgba(255,255,255,0.8)'
                : 'rgba(37, 99, 235, 0.04)',
              border: '1px solid rgba(0,0,0,0.03)',
              fontSize: 13,
              lineHeight: 1.55,
              color: '#334155',
            }}
          >
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: msg.role === 'assistant' ? '#64748b' : '#2563eb',
              marginBottom: 4,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {msg.role}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {typeof msg.content === 'string'
                ? msg.content.slice(0, 2000)
                : JSON.stringify(msg.content).slice(0, 2000)}
            </div>
          </div>
        ))
      )}
    </div>
  );
});

interface TranscriptMessage {
  role: string;
  content: string | object;
}

// ── File Viewer ──

const FileViewer = memo(function FileViewer({ filePath, workspace }: { filePath: string; workspace?: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [hasDiff, setHasDiff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState<'content' | 'diff'>('content');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Fetch file content
    const wsParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
    Promise.all([
      fetch(`/api/panel/file-content?path=${encodeURIComponent(filePath)}${wsParam}`)
        .then(r => r.json()).catch(() => ({ content: null })),
      fetch(`/api/panel/file-diff?path=${encodeURIComponent(filePath)}${wsParam}`)
        .then(r => r.json()).catch(() => ({ diff: '', hasDiff: false })),
    ]).then(([contentData, diffData]) => {
      if (!cancelled) {
        setContent(contentData.content ?? null);
        setDiff(diffData.diff ?? '');
        setHasDiff(diffData.hasDiff ?? false);
        if (diffData.hasDiff) setActiveView('diff');
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [filePath, workspace]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#9ca3af' }}>Loading file…</div>;
  }

  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        paddingTop: 12,
        paddingRight: 20,
        paddingBottom: 10,
        paddingLeft: 20,
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        background: 'rgba(255,255,255,0.4)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
      }}>
        <FileText size={16} strokeWidth={1.8} style={{ color: '#94a3b8' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{fileName}</span>
        <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: '"SF Mono", ui-monospace, monospace' }}>{filePath}</span>

        {hasDiff ? (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
            {(['content', 'diff'] as const).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => setActiveView(view)}
                style={{
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  borderRadius: 6,
                  border: 'none',
                  fontSize: 11,
                  fontWeight: activeView === view ? 600 : 400,
                  color: activeView === view ? '#2563eb' : '#64748b',
                  background: activeView === view ? 'rgba(37,99,235,0.08)' : 'transparent',
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                {view === 'content' ? 'Content' : 'Diff'}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {activeView === 'diff' && hasDiff ? (
          <pre style={{
            margin: 0,
            paddingTop: 14,
            paddingRight: 16,
            paddingBottom: 14,
            paddingLeft: 16,
            fontSize: '0.8rem',
            lineHeight: 1.65,
            fontFamily: '"SF Mono", "Menlo", ui-monospace, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: '#1e293b',
          }}>
            {renderDiffLines(diff)}
          </pre>
        ) : content !== null ? (
          <pre style={{
            margin: 0,
            paddingTop: 14,
            paddingRight: 16,
            paddingBottom: 14,
            paddingLeft: 16,
            fontSize: '0.8rem',
            lineHeight: 1.65,
            fontFamily: '"SF Mono", "Menlo", ui-monospace, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: '#1e293b',
          }}>
            {content}
          </pre>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#94a3b8' }}>
            Could not load file content
          </div>
        )}
      </div>
    </div>
  );
});

// ── Empty State ──

function CanvasEmpty() {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      minHeight: 200,
    }}>
      <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.1, color: '#94a3b8' }}>◇</div>
      <p style={{
        fontSize: 13,
        color: '#b0b8c8',
        letterSpacing: '-0.01em',
      }}>
        Select an issue, agent, or file to open here
      </p>
    </div>
  );
}

// ── Git Log Viewer ──

interface GitLogCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  refs: { type: string; name: string }[];
}

function GitLogViewer({ workspace, onSelectCommit }: { workspace: string; onSelectCommit?: (hash: string) => void }) {
  const [commits, setCommits] = useState<GitLogCommit[]>([]);
  const [currentBranch, setCurrentBranch] = useState('main');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const wsParam = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    fetch(`/api/panel/git-log${wsParam}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setCommits(data.commits ?? []);
          setCurrentBranch(data.currentBranch ?? 'main');
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspace]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#9ca3af' }}>Loading git log…</div>;
  }

  if (commits.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#94a3b8' }}>No commits found</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        paddingTop: 12,
        paddingRight: 20,
        paddingBottom: 10,
        paddingLeft: 20,
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        background: 'rgba(255,255,255,0.4)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <GitCommit size={16} strokeWidth={1.8} style={{ color: '#64748b' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Git History</span>
        <span style={{
          fontSize: 11,
          fontFamily: '"SF Mono", ui-monospace, monospace',
          paddingTop: 2,
          paddingRight: 8,
          paddingBottom: 2,
          paddingLeft: 8,
          borderRadius: 99,
          background: 'rgba(59,130,246,0.08)',
          color: '#3b82f6',
          fontWeight: 600,
        }}>{currentBranch}</span>
        <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 'auto' }}>{commits.length} commits</span>
      </div>

      {/* Commit list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {commits.map((commit, i) => (
          <button
            key={commit.hash}
            type="button"
            onClick={() => onSelectCommit?.(commit.hash)}
            style={{
              display: 'flex',
              gap: 12,
              width: '100%',
              paddingTop: 10,
              paddingRight: 20,
              paddingBottom: 10,
              paddingLeft: 20,
              border: 'none',
              borderBottom: '1px solid rgba(0,0,0,0.03)',
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: '-apple-system, system-ui, sans-serif',
              transition: 'background 80ms ease',
              position: 'relative',
            }}
          >
            {/* Graph line */}
            <div style={{
              width: 20,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              flexShrink: 0,
              position: 'relative',
            }}>
              {i > 0 ? (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  width: 2,
                  height: 10,
                  background: 'rgba(148, 163, 184, 0.3)',
                }} />
              ) : null}
              <div style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background: commit.refs.some(r => r.type === 'head') ? '#3b82f6' : '#cbd5e1',
                border: commit.refs.some(r => r.type === 'head') ? '2px solid rgba(59,130,246,0.3)' : '2px solid rgba(0,0,0,0.04)',
                marginTop: 6,
                flexShrink: 0,
                zIndex: 1,
              }} />
              {i < commits.length - 1 ? (
                <div style={{
                  width: 2,
                  flex: 1,
                  background: 'rgba(148, 163, 184, 0.3)',
                  marginTop: 2,
                }} />
              ) : null}
            </div>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 13,
                  fontWeight: 400,
                  color: '#1e293b',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                }}>{commit.subject}</span>

                {/* Ref badges */}
                {commit.refs.map((ref, j) => (
                  <span key={j} style={{
                    fontSize: 10,
                    fontWeight: 600,
                    paddingTop: 1,
                    paddingRight: 6,
                    paddingBottom: 1,
                    paddingLeft: 6,
                    borderRadius: 4,
                    flexShrink: 0,
                    ...(ref.type === 'head'
                      ? { color: '#3b82f6', background: 'rgba(59,130,246,0.08)' }
                      : ref.type === 'tag'
                        ? { color: '#f59e0b', background: 'rgba(245,158,11,0.08)' }
                        : { color: '#94a3b8', background: 'rgba(0,0,0,0.03)' }
                    ),
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}>
                    {ref.name}
                  </span>
                ))}
              </div>

              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 3,
                fontSize: 11,
                color: '#94a3b8',
              }}>
                <span style={{
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  fontSize: 11,
                  color: '#64748b',
                  fontWeight: 500,
                }}>{commit.shortHash}</span>
                <span>{commit.author}</span>
                <span>·</span>
                <span>{formatAge(commit.date)}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Image Preview ──

function ImagePreview({ filePath, workspace }: { filePath: string; workspace?: string }) {
  const [imageData, setImageData] = useState<{ type: string; dataUrl?: string; content?: string; mimeType: string; size: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const wsParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
    fetch(`/api/panel/file-preview?path=${encodeURIComponent(filePath)}${wsParam}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          if (data.error) {
            setError(data.error);
          } else {
            setImageData(data);
          }
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) { setError('Failed to load image'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filePath, workspace]);

  const fileName = filePath.split('/').pop() ?? filePath;

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#9ca3af' }}>Loading image…</div>;
  }

  if (error || !imageData) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#ef4444' }}>{error || 'Could not load image'}</div>;
  }

  const sizeLabel = imageData.size < 1024
    ? `${imageData.size} B`
    : imageData.size < 1024 * 1024
      ? `${(imageData.size / 1024).toFixed(1)} KB`
      : `${(imageData.size / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        paddingTop: 12,
        paddingRight: 20,
        paddingBottom: 10,
        paddingLeft: 20,
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        background: 'rgba(255,255,255,0.4)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <FileText size={16} strokeWidth={1.8} style={{ color: '#94a3b8' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>{fileName}</span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{imageData.mimeType} · {sizeLabel}</span>
      </div>

      {/* Image */}
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'auto',
        padding: 24,
        background: 'repeating-conic-gradient(rgba(0,0,0,0.04) 0% 25%, transparent 0% 50%) 50% / 16px 16px',
      }}>
        {imageData.type === 'svg' && imageData.content ? (
          <div
            dangerouslySetInnerHTML={{ __html: imageData.content }}
            style={{ maxWidth: '100%', maxHeight: '100%' }}
          />
        ) : imageData.dataUrl ? (
          <img
            src={imageData.dataUrl}
            alt={fileName}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              borderRadius: 4,
              boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── README Viewer ──

function ReadmeViewer({ workspace }: { workspace: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/panel/readme?workspace=${encodeURIComponent(workspace)}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setContent(data.content);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspace]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#9ca3af' }}>Loading README…</div>;
  }

  if (!content) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#94a3b8' }}>No README found in this workspace</div>;
  }

  return (
    <div style={{ padding: '24px 32px', overflowY: 'auto', height: '100%' }}>
      <MarkdownBody text={content} />
    </div>
  );
}

// ── CI Viewer ──

interface CIRun {
  databaseId: number;
  displayTitle: string;
  event: string;
  headBranch: string;
  status: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
  workflowName: string;
  url: string;
}

interface CIRunDetail extends CIRun {
  jobs: { name: string; status: string; conclusion: string; startedAt: string; completedAt: string }[];
}

function ciColor(conclusion: string, status: string): string {
  if (status === 'in_progress' || status === 'queued') return '#f59e0b';
  if (conclusion === 'success') return '#22c55e';
  if (conclusion === 'failure') return '#ef4444';
  if (conclusion === 'cancelled') return '#6b7280';
  return '#94a3b8';
}

function ciIcon(conclusion: string, status: string): string {
  if (status === 'in_progress') return '◉';
  if (status === 'queued') return '○';
  if (conclusion === 'success') return '✓';
  if (conclusion === 'failure') return '✗';
  if (conclusion === 'cancelled') return '⊘';
  return '○';
}

function CIViewer({ repo }: { repo?: string }) {
  const [runs, setRuns] = useState<CIRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [runDetail, setRunDetail] = useState<CIRunDetail | null>(null);
  const [logs, setLogs] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/ci${repoParam}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setRuns(data.runs ?? []);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repo]);

  useEffect(() => {
    if (!selectedRun) { setRunDetail(null); setLogs(''); return; }
    let cancelled = false;
    setDetailLoading(true);
    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/ci/${selectedRun}${repoParam}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setRunDetail(data.run ?? null);
          setLogs(data.logs ?? '');
          setDetailLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedRun, repo]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#9ca3af' }}>Loading CI runs…</div>;
  }

  if (runs.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#94a3b8' }}>No workflow runs found</div>;
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Run list */}
      <div style={{
        width: 340,
        flexShrink: 0,
        borderRight: '1px solid rgba(0,0,0,0.06)',
        overflowY: 'auto',
        background: 'rgba(248, 250, 252, 0.6)',
      }}>
        {runs.map((run) => {
          const color = ciColor(run.conclusion, run.status);
          const icon = ciIcon(run.conclusion, run.status);
          const isActive = selectedRun === run.databaseId;
          return (
            <button
              key={run.databaseId}
              type="button"
              onClick={() => setSelectedRun(run.databaseId)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                width: '100%',
                paddingTop: 10,
                paddingRight: 14,
                paddingBottom: 10,
                paddingLeft: 14,
                border: 'none',
                borderLeft: isActive ? `3px solid ${color}` : '3px solid transparent',
                background: isActive ? 'rgba(37, 99, 235, 0.04)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: '-apple-system, system-ui, sans-serif',
                borderBottom: '1px solid rgba(0,0,0,0.04)',
              }}
            >
              <span style={{
                fontSize: 16,
                color,
                fontWeight: 700,
                lineHeight: 1.2,
                flexShrink: 0,
                marginTop: 1,
              }}>{icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  color: '#1e293b',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>{run.displayTitle}</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{run.headBranch}</span>
                  <span>·</span>
                  <span>{run.workflowName}</span>
                  <span>·</span>
                  <span>{formatAge(run.createdAt)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Detail */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!selectedRun ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#94a3b8' }}>
            Select a run to view details
          </div>
        ) : detailLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#9ca3af' }}>
            Loading run details…
          </div>
        ) : runDetail ? (
          <div style={{ paddingTop: 16, paddingRight: 20, paddingBottom: 16, paddingLeft: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', marginBottom: 8 }}>
              {runDetail.displayTitle}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#64748b', marginBottom: 16 }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                paddingTop: 2,
                paddingRight: 8,
                paddingBottom: 2,
                paddingLeft: 8,
                borderRadius: 99,
                fontSize: 11,
                fontWeight: 600,
                color: ciColor(runDetail.conclusion, runDetail.status),
                background: `${ciColor(runDetail.conclusion, runDetail.status)}12`,
              }}>
                {ciIcon(runDetail.conclusion, runDetail.status)} {runDetail.conclusion || runDetail.status}
              </span>
              <span>{runDetail.workflowName}</span>
              <span>·</span>
              <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{runDetail.headBranch}</span>
              <span>·</span>
              <span>{runDetail.event}</span>
            </div>

            {/* Jobs */}
            {runDetail.jobs?.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Jobs
                </div>
                {runDetail.jobs.map((job, i) => {
                  const jColor = ciColor(job.conclusion, job.status);
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 4 }}>
                      <span style={{ color: jColor, fontWeight: 700 }}>{ciIcon(job.conclusion, job.status)}</span>
                      <span style={{ color: '#1e293b' }}>{job.name}</span>
                      <span style={{ fontSize: 11, color: '#94a3b8' }}>{job.conclusion || job.status}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* Logs */}
            {logs ? (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Logs
                </div>
                <pre style={{
                  margin: 0,
                  padding: 14,
                  fontSize: '0.75rem',
                  lineHeight: 1.5,
                  fontFamily: '"SF Mono", "Menlo", ui-monospace, monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: '#1e293b',
                  background: 'rgba(0,0,0,0.02)',
                  borderRadius: 8,
                  border: '1px solid rgba(0,0,0,0.06)',
                  maxHeight: 500,
                  overflowY: 'auto',
                }}>
                  {logs}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── PR Viewer ──

interface PRDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  mergedBy: { login: string } | null;
  labels: { name: string; color: string }[];
  reviews: { author: { login: string }; state: string; body: string }[];
  files: { path: string; additions: number; deletions: number }[];
  statusCheckRollup: { name: string; status: string; conclusion: string }[];
  reviewComments: { id: number; body: string; user: string; path: string; line: number | null; created_at: string }[];
  issueComments: { id: number; body: string; user: string; created_at: string }[];
  diffStat: string;
  url: string;
}

const prStateStyles: Record<string, { color: string; label: string; bg: string }> = {
  OPEN: { color: '#22c55e', label: 'Open', bg: 'rgba(34,197,94,0.08)' },
  MERGED: { color: '#8b5cf6', label: 'Merged', bg: 'rgba(139,92,246,0.08)' },
  CLOSED: { color: '#ef4444', label: 'Closed', bg: 'rgba(239,68,68,0.08)' },
};

function PRViewer({ prNumber, repo }: { prNumber: number; repo?: string }) {
  const [pr, setPr] = useState<PRDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'overview' | 'files' | 'comments' | 'reviews'>('overview');
  const [reviewComments, setReviewComments] = useState<{
    id: number; author: string; body: string; path: string;
    line: number | null; createdAt: string; diffHunk: string; inReplyTo: number | null;
  }[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/prs/${prNumber}${repoParam}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) {
          setPr(data.pr);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [prNumber]);

  // Fetch review comments when tab is activated
  useEffect(() => {
    if (activeSection !== 'reviews' || reviewComments.length > 0) return;
    let cancelled = false;
    setReviewsLoading(true);
    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/prs/${prNumber}/comments${repoParam}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setReviewComments(data.comments ?? []);
          setReviewsLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setReviewsLoading(false); });
    return () => { cancelled = true; };
  }, [activeSection, prNumber, repo, reviewComments.length]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#9ca3af' }}>Loading PR…</div>;
  }

  if (error || !pr) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#ef4444' }}>Failed to load PR: {error || 'Unknown'}</div>;
  }

  const stateStyle = prStateStyles[pr.state] ?? { color: '#6b7280', label: pr.state, bg: 'rgba(0,0,0,0.04)' };
  const allComments = [
    ...pr.issueComments.map(c => ({ ...c, kind: 'comment' as const })),
    ...pr.reviewComments.map(c => ({ ...c, kind: 'review' as const })),
  ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const ciChecks = pr.statusCheckRollup ?? [];
  const passedChecks = ciChecks.filter(c => c.conclusion === 'SUCCESS' || c.conclusion === 'success').length;

  const sections: { id: 'overview' | 'files' | 'comments' | 'reviews'; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'files', label: 'Files', count: pr.changedFiles },
    { id: 'comments', label: 'Comments', count: allComments.length },
    { id: 'reviews', label: 'Reviews' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        paddingTop: 16,
        paddingRight: 20,
        paddingBottom: 12,
        paddingLeft: 20,
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        background: 'rgba(255,255,255,0.4)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 3,
            paddingRight: 8,
            paddingBottom: 3,
            paddingLeft: 8,
            borderRadius: 99,
            fontSize: 11,
            fontWeight: 600,
            color: stateStyle.color,
            background: stateStyle.bg,
          }}>
            {stateStyle.label}
          </span>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>
            #{pr.number} {pr.title}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12, color: '#64748b' }}>
          <span>{pr.author.login}</span>
          <span>wants to merge</span>
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 11,
            paddingTop: 1,
            paddingRight: 5,
            paddingBottom: 1,
            paddingLeft: 5,
            borderRadius: 4,
            background: 'rgba(0,0,0,0.04)',
          }}>{pr.headRefName}</span>
          <span>→</span>
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 11,
            paddingTop: 1,
            paddingRight: 5,
            paddingBottom: 1,
            paddingLeft: 5,
            borderRadius: 4,
            background: 'rgba(0,0,0,0.04)',
          }}>{pr.baseRefName}</span>
          <span>·</span>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>+{pr.additions}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>-{pr.deletions}</span>
          <span>·</span>
          <span>{formatAge(pr.createdAt)}</span>
        </div>
        {pr.mergedBy ? (
          <div style={{ fontSize: 12, color: '#8b5cf6', marginTop: 4 }}>
            Merged by {pr.mergedBy.login} {pr.mergedAt ? formatAge(pr.mergedAt) : ''}
          </div>
        ) : null}

        {/* Section tabs */}
        <div style={{ display: 'flex', gap: 2, marginTop: 10 }}>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSection(s.id)}
              style={{
                paddingTop: 5,
                paddingRight: 12,
                paddingBottom: 5,
                paddingLeft: 12,
                borderRadius: 8,
                border: 'none',
                fontSize: 12,
                fontWeight: activeSection === s.id ? 600 : 400,
                color: activeSection === s.id ? '#2563eb' : '#64748b',
                background: activeSection === s.id ? 'rgba(37,99,235,0.08)' : 'transparent',
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              {s.label}{s.count !== undefined ? ` (${s.count})` : ''}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 16, paddingRight: 20, paddingBottom: 16, paddingLeft: 20 }}>
        {activeSection === 'overview' ? (
          <div>
            {/* CI Status */}
            {ciChecks.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  CI Checks ({passedChecks}/{ciChecks.length} passed)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {ciChecks.map((check, i) => {
                    const passed = check.conclusion === 'SUCCESS' || check.conclusion === 'success';
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                        <span style={{ color: passed ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                          {passed ? '✓' : '✗'}
                        </span>
                        <span style={{ color: '#1e293b' }}>{check.name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Reviews */}
            {pr.reviews.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Reviews
                </div>
                {pr.reviews.map((review, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
                    <span style={{
                      color: review.state === 'APPROVED' ? '#22c55e' : review.state === 'CHANGES_REQUESTED' ? '#ef4444' : '#f59e0b',
                      fontWeight: 600,
                    }}>
                      {review.state === 'APPROVED' ? '✓' : review.state === 'CHANGES_REQUESTED' ? '✗' : '○'}
                    </span>
                    <span style={{ color: '#1e293b' }}>{review.author.login}</span>
                    <span style={{ color: '#94a3b8' }}>{review.state.toLowerCase().replace('_', ' ')}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Labels */}
            {pr.labels.length > 0 ? (
              <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
                {pr.labels.map((label) => (
                  <span key={label.name} style={{
                    fontSize: 11,
                    fontWeight: 600,
                    paddingTop: 2,
                    paddingRight: 8,
                    paddingBottom: 2,
                    paddingLeft: 8,
                    borderRadius: 99,
                    color: `#${label.color}`,
                    background: `#${label.color}10`,
                    border: `1px solid #${label.color}25`,
                  }}>
                    {label.name}
                  </span>
                ))}
              </div>
            ) : null}

            {/* Body */}
            {pr.body ? (
              <div style={{ marginTop: 8 }}>
                <MarkdownBody text={pr.body} />
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#94a3b8', fontStyle: 'italic' }}>No description provided</div>
            )}
          </div>
        ) : null}

        {activeSection === 'files' ? (
          <div>
            {pr.files?.length > 0 ? (
              pr.files.map((file) => (
                <div key={file.path} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  paddingTop: 6,
                  paddingBottom: 6,
                  borderBottom: '1px solid rgba(0,0,0,0.04)',
                  fontSize: 13,
                }}>
                  <FileText size={14} strokeWidth={1.8} style={{ color: '#94a3b8', flexShrink: 0 }} />
                  <span style={{ flex: 1, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.path}
                  </span>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
                    {file.additions > 0 ? <span style={{ color: '#22c55e' }}>+{file.additions}</span> : null}
                    {file.deletions > 0 ? <span style={{ color: '#ef4444' }}>-{file.deletions}</span> : null}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ fontSize: 13, color: '#94a3b8' }}>No changed files data</div>
            )}
            {pr.diffStat ? (
              <pre style={{
                marginTop: 12,
                fontSize: '0.75rem',
                lineHeight: 1.5,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                color: '#64748b',
                whiteSpace: 'pre-wrap',
              }}>
                {pr.diffStat}
              </pre>
            ) : null}
          </div>
        ) : null}

        {activeSection === 'comments' ? (
          <div>
            {allComments.length === 0 ? (
              <div style={{ fontSize: 13, color: '#94a3b8' }}>No comments</div>
            ) : (
              allComments.map((comment) => (
                <div key={`${comment.kind}-${comment.id}`} style={{
                  marginBottom: 16,
                  paddingBottom: 16,
                  borderBottom: '1px solid rgba(0,0,0,0.06)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: '#1e293b' }}>{comment.user}</span>
                    {comment.kind === 'review' ? (
                      <span style={{
                        fontSize: 10,
                        paddingTop: 1,
                        paddingRight: 5,
                        paddingBottom: 1,
                        paddingLeft: 5,
                        borderRadius: 4,
                        background: 'rgba(139,92,246,0.08)',
                        color: '#8b5cf6',
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                      }}>
                        {'path' in comment ? (comment as { path: string }).path : 'review'}
                      </span>
                    ) : null}
                    <span style={{ color: '#94a3b8' }}>{formatAge(comment.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                    <MarkdownBody text={comment.body} />
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {activeSection === 'reviews' ? (
          <div>
            {reviewsLoading ? (
              <div style={{ fontSize: 13, color: '#94a3b8' }}>Loading review comments…</div>
            ) : reviewComments.length === 0 ? (
              <div style={{ fontSize: 13, color: '#94a3b8' }}>No inline review comments</div>
            ) : (
              (() => {
                // Group comments into threads by file path
                const threads = new Map<string, typeof reviewComments>();
                for (const c of reviewComments) {
                  const key = c.path;
                  if (!threads.has(key)) threads.set(key, []);
                  threads.get(key)!.push(c);
                }

                return Array.from(threads.entries()).map(([path, comments]) => (
                  <div key={path} style={{ marginBottom: 20 }}>
                    {/* File path header */}
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      paddingTop: 8,
                      paddingRight: 12,
                      paddingBottom: 8,
                      paddingLeft: 12,
                      borderRadius: 8,
                      background: 'rgba(0,0,0,0.02)',
                      marginBottom: 8,
                    }}>
                      <FileText size={13} strokeWidth={1.8} style={{ color: '#64748b', flexShrink: 0 }} />
                      <span style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: '#1e293b',
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                      }}>{path}</span>
                    </div>

                    {/* Comments for this file */}
                    {comments.map((comment) => (
                      <div key={comment.id} style={{
                        marginBottom: 12,
                        paddingLeft: 16,
                        borderLeft: '2px solid rgba(139, 92, 246, 0.2)',
                      }}>
                        {/* Diff context */}
                        {comment.diffHunk ? (
                          <pre style={{
                            margin: 0,
                            marginBottom: 8,
                            paddingTop: 8,
                            paddingRight: 12,
                            paddingBottom: 8,
                            paddingLeft: 12,
                            fontSize: '0.7rem',
                            lineHeight: 1.5,
                            fontFamily: '"SF Mono", ui-monospace, monospace',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            color: '#475569',
                            background: 'rgba(0,0,0,0.02)',
                            borderRadius: 6,
                            border: '1px solid rgba(0,0,0,0.04)',
                            maxHeight: 120,
                            overflowY: 'auto',
                          }}>
                            {renderDiffLines(comment.diffHunk)}
                          </pre>
                        ) : null}

                        {/* Line reference */}
                        {comment.line ? (
                          <div style={{
                            fontSize: 10,
                            color: '#8b5cf6',
                            fontFamily: '"SF Mono", ui-monospace, monospace',
                            marginBottom: 4,
                          }}>
                            Line {comment.line}
                          </div>
                        ) : null}

                        {/* Author + timestamp */}
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          marginBottom: 4,
                          fontSize: 12,
                        }}>
                          <span style={{ fontWeight: 600, color: '#1e293b' }}>{comment.author}</span>
                          <span style={{ color: '#94a3b8' }}>{formatAge(comment.createdAt)}</span>
                        </div>

                        {/* Comment body */}
                        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                          <MarkdownBody text={comment.body} />
                        </div>
                      </div>
                    ))}
                  </div>
                ));
              })()
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Commit Viewer ──

interface CommitDetail {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  date: string;
  files: { path: string; additions: number | null; deletions: number | null }[];
  totalAdditions: number;
  totalDeletions: number;
  diff: string;
}

function CommitViewer({ commitHash }: { commitHash: string }) {
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/panel/commits/${commitHash}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) {
          setCommit(data.commit);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [commitHash]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#9ca3af' }}>
        Loading commit…
      </div>
    );
  }

  if (error || !commit) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#ef4444' }}>
        Failed to load commit: {error || 'Unknown error'}
      </div>
    );
  }

  // Parse diff into per-file sections
  const fileDiffs = new Map<string, string>();
  if (commit.diff) {
    const sections = commit.diff.split(/^diff --git /m).filter(Boolean);
    for (const section of sections) {
      const firstLine = section.split('\n')[0] ?? '';
      const match = firstLine.match(/b\/(.+)$/);
      if (match) {
        fileDiffs.set(match[1], 'diff --git ' + section);
      }
    }
  }

  const activeDiff = selectedFile ? (fileDiffs.get(selectedFile) ?? '') : commit.diff;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        paddingTop: 16,
        paddingRight: 20,
        paddingBottom: 12,
        paddingLeft: 20,
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        background: 'rgba(255,255,255,0.4)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', lineHeight: 1.4 }}>
          {commit.subject}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, fontSize: 12, color: '#64748b' }}>
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 11,
            paddingTop: 2,
            paddingRight: 6,
            paddingBottom: 2,
            paddingLeft: 6,
            borderRadius: 4,
            background: 'rgba(0,0,0,0.04)',
            color: '#475569',
          }}>
            {commit.shortHash}
          </span>
          <span>{commit.author}</span>
          <span>·</span>
          <span>{formatAge(commit.date)}</span>
          <span>·</span>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>+{commit.totalAdditions}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>-{commit.totalDeletions}</span>
          <span>{commit.files.length} file{commit.files.length !== 1 ? 's' : ''}</span>
        </div>
        {commit.body ? (
          <div style={{ marginTop: 8, fontSize: 13, color: '#475569', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            {commit.body}
          </div>
        ) : null}
      </div>

      {/* Body: file list + diff */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* File list sidebar */}
        <div style={{
          width: 260,
          flexShrink: 0,
          borderRight: '1px solid rgba(0,0,0,0.06)',
          overflowY: 'auto',
          background: 'rgba(248, 250, 252, 0.6)',
        }}>
          {/* "All files" option */}
          <button
            type="button"
            onClick={() => setSelectedFile(null)}
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
              borderLeft: selectedFile === null ? '2px solid #2563eb' : '2px solid transparent',
              background: selectedFile === null ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: '-apple-system, system-ui, sans-serif',
              fontSize: 13,
              fontWeight: selectedFile === null ? 600 : 400,
              color: '#1e293b',
            }}
          >
            All files ({commit.files.length})
          </button>

          {commit.files.map((file) => {
            const isActive = selectedFile === file.path;
            const fileName = file.path.split('/').pop() ?? file.path;
            const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

            return (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedFile(file.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  paddingTop: 8,
                  paddingRight: 12,
                  paddingBottom: 8,
                  paddingLeft: 14,
                  border: 'none',
                  borderLeft: isActive ? '2px solid #2563eb' : '2px solid transparent',
                  background: isActive ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  transition: 'all 100ms ease',
                }}
              >
                <FileText size={14} strokeWidth={1.8} style={{ color: '#94a3b8', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 400,
                    color: '#1e293b',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>{fileName}</div>
                  {dirPath ? (
                    <div style={{
                      fontSize: 11,
                      color: '#94a3b8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>{dirPath}</div>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
                  {(file.additions ?? 0) > 0 ? <span style={{ color: '#22c55e' }}>+{file.additions}</span> : null}
                  {(file.deletions ?? 0) > 0 ? <span style={{ color: '#ef4444' }}>-{file.deletions}</span> : null}
                </div>
                <ChevronRight size={12} strokeWidth={2} style={{ color: '#cbd5e1', flexShrink: 0 }} />
              </button>
            );
          })}
        </div>

        {/* Diff preview */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <pre style={{
            margin: 0,
            paddingTop: 14,
            paddingRight: 16,
            paddingBottom: 14,
            paddingLeft: 16,
            fontSize: '0.8rem',
            lineHeight: 1.65,
            fontFamily: '"SF Mono", "Menlo", "Monaco", ui-monospace, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: '#1e293b',
          }}>
            {renderDiffLines(activeDiff)}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ── Diff Viewer (inline version of DiffModal) ──

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

const diffStatusColors: Record<string, string> = {
  added: '#22c55e',
  modified: '#f59e0b',
  deleted: '#ef4444',
  renamed: '#8b5cf6',
  untracked: '#6b7280',
};

function DiffStatusIcon({ status }: { status: string }) {
  const color = diffStatusColors[status] ?? '#6b7280';
  const size = 15;
  switch (status) {
    case 'added': return <FilePlus size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    case 'deleted': return <FileMinus size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    case 'modified': return <FileEdit size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    default: return <FileText size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
  }
}

function renderDiffLines(text: string) {
  return text.split('\n').map((line, i) => {
    let color = '#1e293b';
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
      color = '#64748b';
    }
    return (
      <div key={i} style={{ color, background: bg, paddingTop: 1, paddingBottom: 1 }}>
        {line || '\u00A0'}
      </div>
    );
  });
}

function DiffViewer() {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDetail, setFileDetail] = useState<FileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/review/workspace');
        if (!res.ok) return;
        const data = await res.json();
        setFiles(data.changedFiles ?? []);
      } catch { /* silent */ }
      finally { setLoading(false); }
    }
    void load();
  }, []);

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

  const totalAdditions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 12,
        paddingRight: 16,
        paddingBottom: 12,
        paddingLeft: 20,
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        background: 'rgba(255,255,255,0.4)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 13,
          fontWeight: 700,
          color: '#0f172a',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>
          Workspace Diff
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#22c55e' }}>+{totalAdditions}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#ef4444' }}>-{totalDeletions}</span>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          {files.length} file{files.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Body: file list + diff preview */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* File list sidebar */}
        <div style={{
          width: 260,
          flexShrink: 0,
          borderRight: '1px solid rgba(0,0,0,0.06)',
          overflowY: 'auto',
          background: 'rgba(248, 250, 252, 0.6)',
        }}>
          {loading ? (
            <div style={{ padding: 20, fontSize: 13, color: '#9ca3af' }}>Loading…</div>
          ) : files.length === 0 ? (
            <div style={{ padding: 20, fontSize: 13, color: '#9ca3af' }}>Working tree clean</div>
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
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    transition: 'all 100ms ease',
                  }}
                >
                  <DiffStatusIcon status={file.status} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: isActive ? 600 : 400,
                      color: '#1e293b',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>{fileName}</div>
                    {dirPath ? (
                      <div style={{
                        fontSize: 11,
                        color: '#94a3b8',
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
                  <ChevronRight size={12} strokeWidth={2} style={{ color: '#cbd5e1', flexShrink: 0 }} />
                </button>
              );
            })
          )}
        </div>

        {/* Diff preview */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!selectedFile ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              fontSize: 14,
              color: '#94a3b8',
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
              color: '#9ca3af',
            }}>
              Loading diff…
            </div>
          ) : fileDetail ? (
            <div>
              <div style={{
                paddingTop: 12,
                paddingRight: 16,
                paddingBottom: 12,
                paddingLeft: 16,
                borderBottom: '1px solid rgba(0,0,0,0.06)',
                background: 'rgba(255,255,255,0.3)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}>
                <DiffStatusIcon status={fileDetail.status} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{fileDetail.path}</span>
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
                  borderBottom: '1px solid rgba(0,0,0,0.04)',
                  fontSize: 12,
                  color: '#64748b',
                }}>
                  {fileDetail.commitSummary} — {fileDetail.commitAuthor} ({fileDetail.commitAge})
                </div>
              ) : null}
              <pre style={{
                margin: 0,
                paddingTop: 14,
                paddingRight: 16,
                paddingBottom: 14,
                paddingLeft: 16,
                fontSize: '0.8rem',
                lineHeight: 1.65,
                fontFamily: '"SF Mono", "Menlo", "Monaco", ui-monospace, monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: '#1e293b',
              }}>
                {renderDiffLines(fileDetail.preview)}
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
  );
}

// ── Utilities ──

function formatAge(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
