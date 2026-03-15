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
  Clock,
  ExternalLink,
  FileText,
  GitCommit,
  MessageSquare,
  Radio,
  Terminal,
  X,
} from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';

// ── Tab Types ──

export type CanvasTabKind = 'issue' | 'transcript' | 'file' | 'diff' | 'welcome';

export interface CanvasTab {
  id: string;
  kind: CanvasTabKind;
  label: string;
  /** Issue number, session key, file path, etc. */
  resourceId: string;
}

export interface CanvasProps {
  tabs: CanvasTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}

// ── Main Canvas ──

export const Canvas = memo(function Canvas({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
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
          <TabContent tab={activeTab} />
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
    case 'welcome': return <BookOpen size={size} />;
  }
}

// ── Tab Content Router ──

const TabContent = memo(function TabContent({ tab }: { tab: CanvasTab }) {
  switch (tab.kind) {
    case 'issue':
      return <IssueViewer issueNumber={parseInt(tab.resourceId, 10)} />;
    case 'transcript':
      return <TranscriptViewer sessionKey={tab.resourceId} />;
    case 'file':
      return <FileViewer filePath={tab.resourceId} />;
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

const IssueViewer = memo(function IssueViewer({ issueNumber }: { issueNumber: number }) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/panel/issues/${issueNumber}`)
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
    <div style={{ padding: '24px 32px', maxWidth: 800 }}>
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

const FileViewer = memo(function FileViewer({ filePath }: { filePath: string }) {
  return (
    <div style={{
      padding: '24px 32px',
      color: '#64748b',
      fontSize: 13,
    }}>
      <div style={{
        fontFamily: 'SF Mono, Menlo, monospace',
        fontSize: 12,
        background: 'rgba(255,255,255,0.8)',
        borderRadius: 14,
        padding: '16px 20px',
        border: '1px solid rgba(0,0,0,0.04)',
        whiteSpace: 'pre',
        overflow: 'auto',
      }}>
        File viewer coming soon: {filePath}
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
