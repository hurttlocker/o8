'use client';

/**
 * AgentPanel — Left panel command center for Cortex IDE.
 *
 * Layout:
 *   Top: Agent status cards (expandable, shows surfaces)
 *   Middle: Tabbed content area (Activity / Issues / Files)
 *
 * Light theme — glass frost on white, matching chat sidebar.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  FileText,
  Folder,
  FolderOpen,
  GitCommit,
  Globe,
  MessageSquare,
  Monitor,
  Radio,
  Tag,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';

// ── Types ──

interface AgentDetail {
  id: string;
  name: string;
  squadId: string;
  model: string;
  status: string;
  currentTask: string;
  workspace: string;
  sessionKey: string;
  lastEventAt: string;
  surfaceLabel: string;
  isCurrentSession: boolean;
  alerts: number;
  context?: { usedPercent: number; trend: string };
  tokenUsage?: { totalTokens: number; remainingTokens: number };
}

interface EventEntry {
  id: string;
  agentId: string;
  squadId: string;
  severity: string;
  title: string;
  detail: string;
  timestamp: string;
}

interface Squad {
  id: string;
  name: string;
  status: string;
  liveSessions: number;
  alerts: number;
  throughputLabel: string;
  members: string[];
}

interface GHIssue {
  number: number;
  title: string;
  labels: { name: string; color: string }[];
  state?: string;
}

interface GHIssueDetail {
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

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

type Tab = 'activity' | 'issues' | 'files';

// ── Status colors ──

const statusDotColor: Record<string, string> = {
  running: '#22c55e',
  watching: '#22c55e',
  healthy: '#22c55e',
  idle: '#f59e0b',
  offline: '#6b7280',
  unhealthy: '#ef4444',
  error: '#ef4444',
};

const severityColor: Record<string, string> = {
  success: '#22c55e',
  info: '#3b82f6',
  warning: '#f59e0b',
  error: '#ef4444',
};

// Surface icon picker
function surfaceIcon(label: string) {
  const l = label.toLowerCase();
  if (l.includes('telegram')) return <MessageSquare size={12} strokeWidth={1.8} />;
  if (l.includes('discord')) return <Radio size={12} strokeWidth={1.8} />;
  if (l.includes('cron') || l.includes('automation')) return <Clock size={12} strokeWidth={1.8} />;
  if (l.includes('codex') || l.includes('terminal')) return <Terminal size={12} strokeWidth={1.8} />;
  if (l.includes('chat') || l.includes('direct')) return <Monitor size={12} strokeWidth={1.8} />;
  return <Globe size={12} strokeWidth={1.8} />;
}

// Context bar color
function ctxColor(pct: number) {
  if (pct >= 70) return '#ef4444';
  if (pct >= 50) return '#f59e0b';
  return '#22c55e';
}

// ── Workspace grouping (matches chat session picker) ──

interface WorkspaceGroup {
  workspace: string;
  displayName: string;
  agents: AgentDetail[];
  hasRunning: boolean;
  bestContextPct: number;
  primaryModel: string;
  totalAlerts: number;
}

function buildWorkspaceGroups(agents: AgentDetail[]): WorkspaceGroup[] {
  const groupMap = new Map<string, AgentDetail[]>();
  for (const agent of agents) {
    const ws = agent.workspace || '~/clawd';
    const existing = groupMap.get(ws) ?? [];
    existing.push(agent);
    groupMap.set(ws, existing);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [workspace, wsAgents] of groupMap) {
    // Derive display name from workspace path
    const segments = workspace.replace(/^~\//, '').split('/');
    const last = segments[segments.length - 1] || segments[0] || 'workspace';
    let displayName = last;
    if (last === 'clawd' && wsAgents.some(a => a.isCurrentSession)) displayName = 'OpenClaw';
    if (workspace.includes('workspace-ace')) displayName = 'Niot';
    if (workspace.includes('workspace-hawk')) displayName = 'Hawk';

    const hasRunning = wsAgents.some(a => a.status === 'running' || a.status === 'watching' || a.status === 'healthy');
    const bestContextPct = Math.max(0, ...wsAgents.map(a => a.context?.usedPercent ?? 0));
    const primary = wsAgents.find(a => !a.id.includes('cron') && !a.id.includes('discord') && !a.id.includes('telegram'));
    const totalAlerts = wsAgents.reduce((sum, a) => sum + (a.alerts ?? 0), 0);

    groups.push({
      workspace,
      displayName,
      agents: wsAgents,
      hasRunning,
      bestContextPct,
      primaryModel: primary?.model ?? '',
      totalAlerts,
    });
  }

  // Sort: Main first, then running groups, then alphabetical
  groups.sort((a, b) => {
    if (a.displayName === 'Main') return -1;
    if (b.displayName === 'Main') return 1;
    if (a.hasRunning && !b.hasRunning) return -1;
    if (!a.hasRunning && b.hasRunning) return 1;
    return a.displayName.localeCompare(b.displayName);
  });

  return groups;
}

// ── Agent Card (expandable, workspace-grouped) ──

const AgentCard = memo(function AgentCard({
  group,
  expanded,
  onToggle,
  onSelectSession,
}: {
  group: WorkspaceGroup;
  expanded: boolean;
  onToggle: () => void;
  onSelectSession?: (sessionKey: string) => void;
}) {
  const dotColor = group.hasRunning ? '#22c55e' : '#6b7280';
  const model = group.primaryModel;
  const ctx = group.bestContextPct > 0 ? { usedPercent: group.bestContextPct } : null;

  return (
    <div style={{
      background: 'rgba(255, 255, 255, 0.7)',
      border: expanded ? '1px solid rgba(37, 99, 235, 0.15)' : '1px solid rgba(0, 0, 0, 0.06)',
      borderRadius: 14,
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      boxShadow: expanded ? '0 2px 8px rgba(37,99,235,0.06)' : '0 1px 3px rgba(0,0,0,0.04)',
      transition: 'all 200ms ease',
      overflow: 'hidden',
    }}>
      {/* Card header — clickable */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 12,
          paddingRight: 14,
          paddingBottom: ctx ? 8 : 12,
          paddingLeft: 14,
          cursor: 'pointer',
        }}
      >
        {/* Avatar */}
        <div style={{
          width: 34,
          height: 34,
          borderRadius: '50%',
          background: `linear-gradient(135deg, ${dotColor}22 0%, ${dotColor}0a 100%)`,
          border: `1.5px solid ${dotColor}44`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          fontWeight: 700,
          color: dotColor,
          flexShrink: 0,
        }}>
          {group.displayName[0]}
        </div>

        {/* Name + model + status */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontSize: 14,
              fontWeight: 600,
              color: '#1e293b',
              letterSpacing: '-0.01em',
            }}>{group.displayName}</span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 10,
              fontWeight: 500,
              color: dotColor,
              paddingTop: 2,
              paddingRight: 7,
              paddingBottom: 2,
              paddingLeft: 5,
              borderRadius: 99,
              background: `${dotColor}12`,
            }}>
              <span style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: dotColor,
                boxShadow: group.hasRunning ? `0 0 6px ${dotColor}` : 'none',
              }} />
              {group.hasRunning ? 'running' : 'idle'}
            </span>
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 3,
          }}>
            {model ? (
              <span style={{
                fontSize: 11,
                color: '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: 3,
              }}>
                <Cpu size={10} strokeWidth={1.8} />
                {model.replace('claude-', '').replace(/-\d+$/, '')}
              </span>
            ) : null}
            <span style={{ fontSize: 11, color: '#cbd5e1' }}>·</span>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>
              {group.agents.length} session{group.agents.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* Alerts + expand chevron */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {group.totalAlerts > 0 ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              fontSize: 11,
              fontWeight: 600,
              color: '#ef4444',
            }}>
              <AlertCircle size={13} strokeWidth={2} />
              {group.totalAlerts}
            </div>
          ) : null}
          {expanded
            ? <ChevronDown size={14} strokeWidth={2} style={{ color: '#94a3b8' }} />
            : <ChevronRight size={14} strokeWidth={2} style={{ color: '#cbd5e1' }} />
          }
        </div>
      </div>

      {/* Context usage bar */}
      {ctx ? (
        <div style={{
          paddingTop: 0,
          paddingRight: 14,
          paddingBottom: 10,
          paddingLeft: 14,
        }}>
          <div style={{
            height: 3,
            borderRadius: 2,
            background: 'rgba(0,0,0,0.04)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${Math.min(ctx.usedPercent, 100)}%`,
              borderRadius: 2,
              background: ctxColor(ctx.usedPercent),
              transition: 'width 300ms ease',
            }} />
          </div>
          <div style={{
            fontSize: 10,
            color: '#94a3b8',
            marginTop: 3,
            display: 'flex',
            justifyContent: 'space-between',
          }}>
            <span>ctx {ctx.usedPercent}%</span>
          </div>
        </div>
      ) : null}

      {/* Expanded: agent list */}
      {expanded ? (
        <div style={{
          borderTop: '1px solid rgba(0,0,0,0.04)',
          paddingTop: 6,
          paddingBottom: 6,
        }}>
          {group.agents.map(agent => (
              <div
                key={agent.id}
                onClick={(e) => {
                  e.stopPropagation();
                  if (agent.sessionKey && onSelectSession) {
                    onSelectSession(agent.sessionKey);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  paddingTop: 6,
                  paddingRight: 14,
                  paddingBottom: 6,
                  paddingLeft: 18,
                  fontSize: 12,
                  cursor: agent.sessionKey ? 'pointer' : 'default',
                  borderRadius: 8,
                  transition: 'background 100ms ease',
                }}
              >
                <span style={{ color: '#94a3b8', flexShrink: 0 }}>
                  {surfaceIcon(agent.surfaceLabel || agent.name)}
                </span>
                <span style={{
                  flex: 1,
                  color: '#475569',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {agent.surfaceLabel || agent.name}
                </span>
                <span style={{
                  fontSize: 10,
                  color: '#94a3b8',
                  flexShrink: 0,
                }}>
                  {agent.lastEventAt}
                </span>
              </div>
            ))
          }
        </div>
      ) : null}
    </div>
  );
});

// ── Activity Feed (rich events) ──

const ActivityFeed = memo(function ActivityFeed({ events, commits }: { events: EventEntry[]; commits: { hash: string; message: string; age: string }[] }) {
  // Merge events + commits into a unified feed
  const items: { type: 'event' | 'commit'; data: EventEntry | { hash: string; message: string; age: string } }[] = [];

  // Add all agent events
  for (const e of events) {
    items.push({ type: 'event', data: e });
  }

  // Add commits
  for (const c of commits) {
    items.push({ type: 'commit', data: c });
  }

  if (!items.length) {
    return <div style={{ padding: 20, fontSize: 13, color: '#94a3b8' }}>No recent activity</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map((item, i) => {
        if (item.type === 'commit') {
          const c = item.data as { hash: string; message: string; age: string };
          return (
            <div key={`c-${c.hash}`} style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              paddingTop: 10,
              paddingRight: 14,
              paddingBottom: 10,
              paddingLeft: 14,
              borderBottom: '1px solid rgba(0,0,0,0.03)',
            }}>
              <div style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: 'rgba(34,197,94,0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                marginTop: 1,
              }}>
                <GitCommit size={12} strokeWidth={2} style={{ color: '#22c55e' }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13,
                  color: '#1e293b',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  lineHeight: 1.4,
                }}>
                  {c.message}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, display: 'flex', gap: 6 }}>
                  <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', color: '#64748b' }}>{c.hash}</span>
                  <span>·</span>
                  <span>{c.age}</span>
                </div>
              </div>
            </div>
          );
        }

        const e = item.data as EventEntry;
        const sColor = severityColor[e.severity] ?? '#64748b';
        return (
          <div key={e.id} style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            paddingTop: 10,
            paddingRight: 14,
            paddingBottom: 10,
            paddingLeft: 14,
            borderBottom: '1px solid rgba(0,0,0,0.03)',
          }}>
            <div style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              background: `${sColor}10`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              marginTop: 1,
            }}>
              <Zap size={11} strokeWidth={2} style={{ color: sColor }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13,
                color: '#1e293b',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                lineHeight: 1.4,
              }}>
                {e.title}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                {e.timestamp}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});

// ── Issues List (light theme, clickable) ──

const IssuesList = memo(function IssuesList({ issues, onSelect }: { issues: GHIssue[]; onSelect: (num: number) => void }) {
  if (!issues.length) {
    return <div style={{ padding: 20, fontSize: 13, color: '#94a3b8' }}>No open issues</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {issues.map((issue) => (
        <div
          key={issue.number}
          onClick={() => onSelect(issue.number)}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            paddingTop: 10,
            paddingRight: 14,
            paddingBottom: 10,
            paddingLeft: 14,
            borderBottom: '1px solid rgba(0,0,0,0.04)',
            cursor: 'pointer',
            transition: 'background 100ms ease',
          }}
        >
          <BookOpen size={14} strokeWidth={1.8} style={{ color: '#94a3b8', marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 600, fontFamily: '"SF Mono", ui-monospace, monospace' }}>#{issue.number}</span>
              <span style={{
                fontSize: 13,
                color: '#1e293b',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}>
                {issue.title}
              </span>
            </div>
            {issue.labels.length > 0 ? (
              <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                {issue.labels.slice(0, 3).map((label) => (
                  <span key={label.name} style={{
                    fontSize: 10,
                    fontWeight: 600,
                    paddingTop: 1,
                    paddingRight: 6,
                    paddingBottom: 1,
                    paddingLeft: 6,
                    borderRadius: 99,
                    color: `#${label.color}`,
                    background: `#${label.color}10`,
                    border: `1px solid #${label.color}25`,
                    textTransform: 'uppercase',
                    letterSpacing: '0.03em',
                  }}>
                    {label.name.replace(/^(priority:|area:|phase:)/, '')}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <ChevronRight size={13} strokeWidth={2} style={{ color: '#cbd5e1', marginTop: 3, flexShrink: 0 }} />
        </div>
      ))}
    </div>
  );
});

// ── Issue Detail Modal (glass) ──

const IssueModal = memo(function IssueModal({ issueNumber, onClose }: { issueNumber: number; onClose: () => void }) {
  const [detail, setDetail] = useState<GHIssueDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/panel/issues/${issueNumber}`);
        if (!res.ok) return;
        const data = await res.json();
        setDetail(data.issue ?? null);
      } catch { /* silent */ }
      finally { setLoading(false); }
    }
    void load();
  }, [issueNumber]);

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
        backdropFilter: 'blur(40px) saturate(200%) brightness(1.05)',
        WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.05)',
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: '85vw',
          height: '82vh',
          maxWidth: 1100,
          borderRadius: 20,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(135deg, rgba(255,255,255,0.45) 0%, rgba(240,247,255,0.25) 100%)',
          border: '1px solid rgba(255,255,255,0.35)',
          boxShadow: '0 32px 80px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.6)',
          backdropFilter: 'blur(60px) saturate(180%)',
          WebkitBackdropFilter: 'blur(60px) saturate(180%)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 16,
          paddingRight: 20,
          paddingBottom: 16,
          paddingLeft: 24,
          borderBottom: '1px solid rgba(0,0,0,0.06)',
          background: 'rgba(255,255,255,0.2)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
            {loading ? (
              <span style={{ fontSize: 14, fontWeight: 600, color: '#64748b' }}>Loading…</span>
            ) : detail ? (
              <>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#ef4444', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                  #{detail.number}
                </span>
                <span style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: '#0f172a',
                  letterSpacing: '-0.01em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>{detail.title}</span>
                <span style={{
                  fontSize: 11,
                  fontWeight: 500,
                  paddingTop: 2,
                  paddingRight: 8,
                  paddingBottom: 2,
                  paddingLeft: 8,
                  borderRadius: 99,
                  background: detail.state === 'OPEN' ? 'rgba(34,197,94,0.1)' : 'rgba(139,92,246,0.1)',
                  color: detail.state === 'OPEN' ? '#16a34a' : '#7c3aed',
                  flexShrink: 0,
                }}>
                  {detail.state?.toLowerCase()}
                </span>
              </>
            ) : (
              <span style={{ fontSize: 14, color: '#ef4444' }}>Issue not found</span>
            )}
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
              border: '1px solid rgba(0,0,0,0.08)',
              background: 'rgba(255,255,255,0.7)',
              color: '#ef4444',
              cursor: 'pointer',
              paddingTop: 0,
              paddingRight: 0,
              paddingBottom: 0,
              paddingLeft: 0,
              flexShrink: 0,
              marginLeft: 12,
            }}
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        {detail ? (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <div style={{
              paddingTop: 12,
              paddingRight: 24,
              paddingBottom: 12,
              paddingLeft: 24,
              borderBottom: '1px solid rgba(0,0,0,0.04)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              fontSize: 12,
              color: '#64748b',
            }}>
              <span>by <strong style={{ color: '#1e293b' }}>{detail.author}</strong></span>
              <span>·</span>
              <span>{new Date(detail.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              <span>·</span>
              <span>{detail.comments} comment{detail.comments !== 1 ? 's' : ''}</span>
              {detail.labels.length > 0 ? (
                <>
                  <span>·</span>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {detail.labels.map((l) => (
                      <span key={l.name} style={{
                        fontSize: 10,
                        fontWeight: 600,
                        paddingTop: 1,
                        paddingRight: 6,
                        paddingBottom: 1,
                        paddingLeft: 6,
                        borderRadius: 99,
                        color: `#${l.color}`,
                        background: `#${l.color}10`,
                        border: `1px solid #${l.color}25`,
                      }}>
                        {l.name}
                      </span>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            <div style={{
              paddingTop: 20,
              paddingRight: 24,
              paddingBottom: 20,
              paddingLeft: 24,
            }}>
              {detail.body ? (
                <MarkdownBody text={detail.body} />
              ) : (
                <p style={{ fontSize: '0.9rem', color: '#94a3b8', fontStyle: 'italic' }}>
                  No description provided.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
});

// ── File Tree (light theme) ──

function FileTreeNode({ node, depth = 0 }: { node: FileNode; depth?: number }) {
  const [open, setOpen] = useState(depth === 0 || node.name === 'src');

  if (node.type === 'file') {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 4,
        paddingRight: 14,
        paddingBottom: 4,
        paddingLeft: 14 + depth * 16,
        fontSize: 12,
        color: '#64748b',
        fontFamily: '"SF Mono", ui-monospace, monospace',
        cursor: 'pointer',
        transition: 'color 100ms',
      }}>
        <FileText size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: '#94a3b8' }} />
        {node.name}
      </div>
    );
  }

  return (
    <div>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 4,
          paddingRight: 14,
          paddingBottom: 4,
          paddingLeft: 14 + depth * 16,
          fontSize: 12,
          fontWeight: 500,
          color: '#1e293b',
          cursor: 'pointer',
          transition: 'color 100ms',
        }}
      >
        {open
          ? <FolderOpen size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: '#3b82f6' }} />
          : <Folder size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: '#3b82f6' }} />
        }
        {node.name}
        {open
          ? <ChevronDown size={11} strokeWidth={2} style={{ color: '#94a3b8' }} />
          : <ChevronRight size={11} strokeWidth={2} style={{ color: '#94a3b8' }} />
        }
      </div>
      {open && node.children ? (
        node.children.map((child) => (
          <FileTreeNode key={child.path} node={child} depth={depth + 1} />
        ))
      ) : null}
    </div>
  );
}

const FileTree = memo(function FileTree({ tree }: { tree: FileNode[] }) {
  if (!tree.length) {
    return <div style={{ padding: 20, fontSize: 13, color: '#94a3b8' }}>No files found</div>;
  }

  return (
    <div style={{ paddingTop: 6, paddingBottom: 6 }}>
      {tree.map((node) => (
        <FileTreeNode key={node.path} node={node} />
      ))}
    </div>
  );
});

// ── Tab Bar ──

const tabs: { id: Tab; icon: typeof Zap; label: string }[] = [
  { id: 'activity', icon: Zap, label: 'Activity' },
  { id: 'issues', icon: Tag, label: 'Issues' },
  { id: 'files', icon: Folder, label: 'Files' },
];

// ── Main Panel ──

export const AgentPanel = memo(function AgentPanel({
  onSelectSession,
  onSelectIssue,
}: {
  onSelectSession?: (sessionKey: string) => void;
  onSelectIssue?: (issueNumber: number) => void;
} = {}) {
  const [agents, setAgents] = useState<AgentDetail[]>([]);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [commits, setCommits] = useState<{ hash: string; message: string; age: string }[]>([]);
  const [issues, setIssues] = useState<GHIssue[]>([]);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('activity');
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  // Build workspace groups from agents
  const workspaceGroups = buildWorkspaceGroups(agents);

  // Fetch agent inventory (agents + events)
  // Only update state when data actually changed (prevents flicker)
  useEffect(() => {
    async function fetchInventory() {
      try {
        const res = await fetch('/api/runtime/inventory');
        if (!res.ok) return;
        const data = await res.json();
        setAgents(prev => JSON.stringify(prev) === JSON.stringify(data.agents ?? []) ? prev : (data.agents ?? []));
        setEvents(prev => JSON.stringify(prev) === JSON.stringify(data.events ?? []) ? prev : (data.events ?? []));
      } catch { /* silent */ }
    }
    void fetchInventory();
    const id = setInterval(fetchInventory, 30_000);
    return () => clearInterval(id);
  }, []);

  // Fetch recent commits
  useEffect(() => {
    async function fetchCommits() {
      try {
        const res = await fetch('/api/review/workspace');
        if (!res.ok) return;
        const data = await res.json();
        const raw: string[] = data.recentCommits ?? [];
        const parsed = raw.map((line) => {
          const spaceIdx = line.indexOf(' ');
          const hash = line.slice(0, spaceIdx);
          const rest = line.slice(spaceIdx + 1);
          const ageMatch = rest.match(/\(([^)]+)\)$/);
          const message = ageMatch ? rest.slice(0, ageMatch.index).trim() : rest;
          const age = ageMatch ? ageMatch[1] : '';
          return { hash, message, age };
        });
        setCommits(prev => JSON.stringify(prev) === JSON.stringify(parsed) ? prev : parsed);
      } catch { /* silent */ }
    }
    void fetchCommits();
    const id = setInterval(fetchCommits, 30_000);
    return () => clearInterval(id);
  }, []);

  // Fetch GitHub issues (every 60s)
  useEffect(() => {
    async function fetchIssues() {
      try {
        const res = await fetch('/api/panel/issues');
        if (!res.ok) return;
        const data = await res.json();
        const fresh = data.issues ?? [];
        setIssues(prev => JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh);
      } catch { /* silent */ }
    }
    void fetchIssues();
    const id = setInterval(fetchIssues, 60_000);
    return () => clearInterval(id);
  }, []);

  // Fetch file tree
  useEffect(() => {
    async function fetchFiles() {
      try {
        const res = await fetch('/api/panel/files');
        if (!res.ok) return;
        const data = await res.json();
        const freshTree = data.tree ?? [];
        setFileTree(prev => JSON.stringify(prev) === JSON.stringify(freshTree) ? prev : freshTree);
      } catch { /* silent */ }
    }
    void fetchFiles();
    const id = setInterval(fetchFiles, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: '#f5f7fb',
    }}>
      {/* ── Titlebar spacer ── */}
      <div style={{
        height: 38,
        flexShrink: 0,
        WebkitAppRegion: 'drag' as unknown as string,
      } as React.CSSProperties} />

      {/* ── Agent Cards ── */}
      <div style={{
        flexShrink: 0,
        paddingTop: 4,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          color: '#94a3b8',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          paddingLeft: 2,
          marginBottom: 2,
        }}>
          Agents
        </div>
        {workspaceGroups.length === 0 ? (
          <div style={{ fontSize: 13, color: '#94a3b8', padding: '8px 2px' }}>Loading agents…</div>
        ) : (
          workspaceGroups.map((group) => (
            <AgentCard
              key={group.workspace}
              group={group}
              expanded={expandedGroup === group.workspace}
              onToggle={() => setExpandedGroup(expandedGroup === group.workspace ? null : group.workspace)}
              onSelectSession={onSelectSession}
            />
          ))
        )}
      </div>

      {/* ── Tab Bar ── */}
      <div style={{
        display: 'flex',
        gap: 2,
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 0,
        paddingLeft: 14,
        flexShrink: 0,
      }}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                paddingTop: 8,
                paddingRight: 0,
                paddingBottom: 8,
                paddingLeft: 0,
                border: 'none',
                borderBottom: isActive ? '2px solid #ef4444' : '2px solid transparent',
                background: 'transparent',
                color: isActive ? '#1e293b' : '#94a3b8',
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                cursor: 'pointer',
                transition: 'all 150ms ease',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              <Icon size={14} strokeWidth={isActive ? 2 : 1.5} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ── Content Area ── */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        borderTop: '1px solid rgba(0,0,0,0.04)',
        marginTop: 4,
      }}>
        {activeTab === 'activity' ? <ActivityFeed events={events} commits={commits} /> : null}
        {activeTab === 'issues' ? <IssuesList issues={issues} onSelect={onSelectIssue || setSelectedIssue} /> : null}
        {activeTab === 'files' ? <FileTree tree={fileTree} /> : null}
      </div>

      {/* ── Issue Detail Modal ── */}
      {selectedIssue !== null ? (
        <IssueModal issueNumber={selectedIssue} onClose={() => setSelectedIssue(null)} />
      ) : null}
    </div>
  );
});
