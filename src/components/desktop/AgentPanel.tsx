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

import { memo, useCallback, useEffect, useRef, useState } from 'react';
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
  PlayCircle,
  Plus,
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
  // Workspace/PR data (populated from /api/panel/workspaces)
  branch?: string;
  pr?: {
    number: number;
    title: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    state: 'open' | 'merged' | 'closed';
    url: string;
  };
  localDiff?: { additions: number; deletions: number; changedFiles: number };
  activity?: { coding: number; thinking: number; testing: number; idle: number };
  workspaceStatus?: 'in_progress' | 'in_review' | 'done' | 'idle' | 'cancelled';
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

interface GHPullRequest {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  labels: { name: string; color: string }[];
}

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

type Tab = 'activity' | 'issues' | 'prs' | 'files' | 'ci' | 'deploy';

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
  repo: string;
  agents: AgentDetail[];
  hasRunning: boolean;
  bestContextPct: number;
  primaryModel: string;
  totalAlerts: number;
}

function deriveRepo(workspace: string, agents: AgentDetail[]): string {
  const path = workspace.replace(/^~\//, '');

  // Unknown or empty workspace — group under OpenClaw
  if (!path || path === 'unknown') return 'openclaw';

  // Explicit repo path
  if (path.includes('repos/')) {
    const parts = path.split('repos/');
    return parts[1]?.split('/')[0] || path.split('/').pop() || 'openclaw';
  }
  if (path.includes('projects/')) {
    const parts = path.split('projects/');
    return parts[1]?.split('/')[0] || path.split('/').pop() || 'openclaw';
  }

  // Main workspace
  if (path === 'clawd') return 'openclaw';

  return path.split('/').pop() || 'openclaw';
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
    const repo = deriveRepo(workspace, wsAgents);
    const repoDisplayNames: Record<string, string> = {
      'openclaw': 'OpenClaw',
      'cortex-ide': 'Cortex IDE',
      'cortex': 'Cortex',
      'parasite-network': 'Parasite Network',
      'spear-production': 'Spear',
      'mybeautifulwife': 'Eyes Web',
    };
    const displayName = repoDisplayNames[repo] || repo;

    const hasRunning = wsAgents.some(a => a.status === 'running' || a.status === 'watching' || a.status === 'healthy');
    const bestContextPct = Math.max(0, ...wsAgents.map(a => a.context?.usedPercent ?? 0));
    const primary = wsAgents.find(a => !a.id.includes('cron') && !a.id.includes('discord') && !a.id.includes('telegram'));
    const totalAlerts = wsAgents.reduce((sum, a) => sum + (a.alerts ?? 0), 0);

    groups.push({
      workspace,
      displayName,
      repo,
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
      border: expanded ? '1px solid rgba(37, 99, 235, 0.15)' : '1px solid var(--t-panel-border)',
      borderRadius: 14,
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      boxShadow: expanded ? '0 2px 8px rgba(37,99,235,0.06)' : 'var(--t-panel-shadow)',
      transition: 'all 200ms ease',
      overflow: 'hidden',
    }}>
      {/* Card header — repo-grouped */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          cursor: 'pointer',
        }}
      >
        {/* GitHub icon */}
        <div style={{ color: 'var(--t-text-secondary)', flexShrink: 0 }}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block' }}>
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
          </svg>
        </div>

        {/* Repo name + agent count */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontSize: 13, fontWeight: 700, color: 'var(--t-text-strong)',
              letterSpacing: '-0.01em',
            }}>{group.displayName}</span>
          </div>
          {/* Agent dots row — shows who's on this repo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            {group.agents.filter(a => !a.id.includes('cron')).slice(0, 4).map(agent => {
              const isRunning = agent.status === 'running' || agent.status === 'watching' || agent.status === 'healthy';
              const agentColor = isRunning ? '#22c55e' : '#9ca3af';
              const isOC = group.repo === 'openclaw';
              const nLow = (agent.name || '').toLowerCase();
              const mLow = (agent.model || '').toLowerCase();
              const dotLabel = isOC
                ? (agent.surfaceLabel || agent.name).replace(/\s*\(.*\)/, '').split(' ')[0]
                : nLow.includes('codex') || mLow.includes('codex') ? 'Codex'
                : nLow.includes('claude') ? 'Claude Code'
                : (agent.surfaceLabel || agent.name).replace(/\s*\(.*\)/, '').split(' ')[0];
              return (
                <div key={agent.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: agentColor, display: 'block',
                    boxShadow: isRunning ? `0 0 6px ${agentColor}` : 'none',
                  }} />
                  <span style={{
                    fontSize: 11, fontWeight: 600,
                    color: isRunning ? 'var(--t-text)' : 'var(--t-text-muted)',
                  }}>
                    {dotLabel}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Context + chevron */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {ctx && (
            <span style={{
              fontSize: 10, fontWeight: 600,
              color: ctxColor(ctx.usedPercent),
              fontFamily: 'SF Mono, Menlo, monospace',
            }}>
              {ctx.usedPercent}%
            </span>
          )}
          {group.totalAlerts > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 3,
              fontSize: 11, fontWeight: 600, color: '#ef4444',
            }}>
              <AlertCircle size={13} strokeWidth={2} />
              {group.totalAlerts}
            </div>
          )}
          {expanded
            ? <ChevronDown size={14} strokeWidth={2} style={{ color: 'var(--t-text-muted)' }} />
            : <ChevronRight size={14} strokeWidth={2} style={{ color: 'var(--t-text-faint)' }} />
          }
        </div>
      </div>

      {/* Context bar */}
      {ctx && (
        <div style={{ padding: '0 14px 8px' }}>
          <div style={{
            height: 3, borderRadius: 2,
            background: 'var(--t-divider-subtle)', overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${Math.min(ctx.usedPercent, 100)}%`,
              borderRadius: 2,
              background: ctxColor(ctx.usedPercent),
              transition: 'width 300ms ease',
            }} />
          </div>
        </div>
      )}

      {/* Expanded: status-grouped agent cards */}
      {expanded && (() => {
        type AgentStatus = 'in_progress' | 'in_review' | 'done' | 'idle';
        const classify = (a: AgentDetail): AgentStatus => {
          // Use workspace status if available (PR-aware)
          if (a.workspaceStatus === 'in_review') return 'in_review';
          if (a.workspaceStatus === 'done') return 'done';
          if (a.status === 'running' || a.status === 'watching' || a.status === 'healthy') return 'in_progress';
          return 'idle';
        };
        const statusGroups: { key: AgentStatus; label: string; color: string; agents: AgentDetail[] }[] = [
          { key: 'in_progress', label: 'In Progress', color: '#2563eb', agents: [] },
          { key: 'in_review', label: 'In Review', color: '#f59e0b', agents: [] },
          { key: 'done', label: 'Done', color: '#22c55e', agents: [] },
          { key: 'idle', label: 'Idle', color: '#9ca3af', agents: [] },
        ];
        for (const agent of group.agents) {
          const status = classify(agent);
          statusGroups.find(g => g.key === status)?.agents.push(agent);
        }

        const renderCard = (agent: AgentDetail) => {
          const isRunning = agent.status === 'running' || agent.status === 'watching' || agent.status === 'healthy';
          const agentDot = isRunning ? '#22c55e' : '#9ca3af';
          const agentCtx = agent.context?.usedPercent ?? 0;
          const agentName = agent.name.replace(/\s*\(.*\)/, '').split(' ')[0];
          // For OpenClaw agents: use session name to differentiate (Mister, Niot, Hawk, etc.)
          // For repo agents: show runtime/editor name (Codex, Claude Code)
          const isOpenClawGroup = group.repo === 'openclaw';
          const nameLower = (agent.name || '').toLowerCase();
          const modelLower = (agent.model || '').toLowerCase();
          const isCodex = nameLower.includes('codex') || modelLower.includes('codex');
          const isClaudeCode = nameLower.includes('claude code') || nameLower.includes('claude-code');
          const fullName = isOpenClawGroup
            ? (agent.surfaceLabel || agent.name)
            : isCodex ? 'Codex'
            : isClaudeCode ? 'Claude Code'
            : (agent.surfaceLabel || agent.name);
          const branch = agent.branch || agent.currentTask || null;
          const progress = agentCtx > 0 ? agentCtx / 100 : 0;
          const agentModel = agent.model ? agent.model.replace('claude-', '').replace(/-\d+$/, '').replace('openai-codex/', '').replace('anthropic/', '') : '';
          const pr = agent.pr;
          const diff = pr ? { add: pr.additions, del: pr.deletions } : agent.localDiff ? { add: agent.localDiff.additions, del: agent.localDiff.deletions } : null;

          return (
            <div
              key={agent.id}
              onClick={(e) => {
                e.stopPropagation();
                if (agent.sessionKey && onSelectSession) onSelectSession(agent.sessionKey);
              }}
              style={{
                padding: '12px', borderRadius: 12,
                background: agent.status === 'running'
                  ? 'linear-gradient(135deg, var(--t-panel) 0%, rgba(147, 197, 253, 0.03) 100%)'
                  : 'var(--t-panel)',
                border: agent.status === 'running'
                  ? '1px solid rgba(147, 197, 253, 0.12)'
                  : '1px solid var(--t-panel-border)',
                cursor: agent.sessionKey ? 'pointer' : 'default',
                transition: 'all 150ms cubic-bezier(0.32, 0.72, 0, 1)',
                animation: agent.status === 'running' ? 'agentCardPulse 3s ease-in-out infinite' : 'none',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.border = '1px solid rgba(37,99,235,0.12)';
                e.currentTarget.style.boxShadow = '0 2px 12px rgba(0,0,0,0.06)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.border = '1px solid var(--t-panel-border)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              {/* Identity row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 10,
                  background: `${agentDot}0a`,
                  border: `1.5px solid ${agentDot}30`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 700, color: agentDot, flexShrink: 0,
                  letterSpacing: '-0.02em',
                }}>
                  {agentName[0]}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
                      {fullName}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2, flexWrap: 'wrap' }}>
                    {agentModel && (
                      <span style={{ fontSize: 10, color: 'var(--t-text-muted)', letterSpacing: '-0.01em' }}>
                        {agentModel}
                      </span>
                    )}
                    {branch && (
                      <>
                        <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                        <span style={{
                          fontSize: 10, color: 'var(--t-text-secondary)',
                          fontFamily: 'SF Mono, Menlo, monospace',
                          maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {branch}
                        </span>
                      </>
                    )}
                    {pr && (
                      <>
                        <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                        <span style={{
                          fontSize: 10, fontWeight: 600,
                          color: pr.state === 'merged' ? '#8b5cf6' : pr.state === 'open' ? '#22c55e' : '#9ca3af',
                        }}>
                          #{pr.number}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {/* Right side: diff stats + context ring */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 'auto' }}>
                  {diff && (
                    <span style={{
                      fontSize: 10, fontWeight: 700,
                      fontFamily: 'SF Mono, Menlo, monospace',
                      display: 'flex', gap: 4, flexShrink: 0,
                    }}>
                      <span style={{ color: '#22c55e' }}>+{diff.add.toLocaleString()}</span>
                      <span style={{ color: '#ef4444' }}>-{diff.del.toLocaleString()}</span>
                    </span>
                  )}
                  {progress > 0 && (
                    <div style={{ position: 'relative', width: 32, height: 32, flexShrink: 0 }}>
                      <svg width={32} height={32} style={{ display: 'block', transform: 'rotate(-90deg)' }}>
                        <circle cx={16} cy={16} r={13} fill="none" stroke="var(--t-divider-subtle)" strokeWidth={2} />
                        <circle cx={16} cy={16} r={13} fill="none" stroke={ctxColor(agentCtx)} strokeWidth={2}
                          strokeDasharray={2 * Math.PI * 13}
                          strokeDashoffset={2 * Math.PI * 13 * (1 - progress)}
                          strokeLinecap="round"
                          style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.32, 0.72, 0, 1)' }}
                        />
                      </svg>
                      <span style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 8, fontWeight: 800, color: ctxColor(agentCtx),
                        fontFamily: 'SF Mono, Menlo, monospace',
                      }}>
                        {agentCtx}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        };

        return (
          <div style={{
            borderTop: '1px solid var(--t-divider-subtle)',
            padding: '6px 10px 10px',
          }}>
            {statusGroups.filter(g => g.agents.length > 0).map(g => (
              <div key={g.key} style={{ marginTop: 8 }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: g.color,
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                  marginBottom: 6, padding: '0 2px',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%', background: g.color,
                    display: 'block',
                  }} />
                  {g.label}
                  <span style={{
                    fontSize: 9, fontWeight: 600, color: 'var(--t-text-muted)',
                    marginLeft: 'auto',
                  }}>
                    {g.agents.length}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {g.agents.map(renderCard)}
                </div>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
});

// ── Activity Feed (rich events) ──

const ActivityFeed = memo(function ActivityFeed({ events, commits, onSelectCommit }: { events: EventEntry[]; commits: { hash: string; message: string; age: string }[]; onSelectCommit?: (hash: string) => void }) {
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
    return <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>No recent activity</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map((item, i) => {
        if (item.type === 'commit') {
          const c = item.data as { hash: string; message: string; age: string };
          return (
            <div
              key={`c-${c.hash}`}
              onClick={() => onSelectCommit?.(c.hash)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                paddingTop: 10,
                paddingRight: 14,
                paddingBottom: 10,
                paddingLeft: 14,
                borderBottom: '1px solid var(--t-divider-subtle)',
                cursor: onSelectCommit ? 'pointer' : 'default',
                transition: 'background 100ms ease',
              }}
              onMouseEnter={(e) => { if (onSelectCommit) (e.currentTarget as HTMLDivElement).style.background = 'rgba(37,99,235,0.04)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
            >
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
                  color: 'var(--t-text-strong)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  lineHeight: 1.4,
                }}>
                  {c.message}
                </div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 2, display: 'flex', gap: 6 }}>
                  <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', color: 'var(--t-text-secondary)' }}>{c.hash}</span>
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
            borderBottom: '1px solid var(--t-divider-subtle)',
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
                color: 'var(--t-text-strong)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                lineHeight: 1.4,
              }}>
                {e.title}
              </div>
              <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 2 }}>
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
    return <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>No open issues</div>;
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
            borderBottom: '1px solid var(--t-divider-subtle)',
            cursor: 'pointer',
            transition: 'background 100ms ease',
          }}
        >
          <BookOpen size={14} strokeWidth={1.8} style={{ color: 'var(--t-text-muted)', marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 600, fontFamily: '"SF Mono", ui-monospace, monospace' }}>#{issue.number}</span>
              <span style={{
                fontSize: 13,
                color: 'var(--t-text-strong)',
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
          <ChevronRight size={13} strokeWidth={2} style={{ color: 'var(--t-text-faint)', marginTop: 3, flexShrink: 0 }} />
        </div>
      ))}
    </div>
  );
});

// ── PR List ──

const prStateColor: Record<string, string> = {
  OPEN: '#22c55e',
  MERGED: '#8b5cf6',
  CLOSED: '#ef4444',
};

const PRList = memo(function PRList({ prs, onSelect }: { prs: GHPullRequest[]; onSelect?: (num: number) => void }) {
  if (!prs.length) {
    return <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>No pull requests</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {prs.map((pr) => {
        const stateColor = prStateColor[pr.state] ?? '#6b7280';
        return (
          <div
            key={pr.number}
            onClick={() => onSelect?.(pr.number)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              paddingTop: 10,
              paddingRight: 14,
              paddingBottom: 10,
              paddingLeft: 14,
              borderBottom: '1px solid var(--t-divider-subtle)',
              cursor: onSelect ? 'pointer' : 'default',
              transition: 'background 100ms ease',
            }}
            onMouseEnter={(e) => { if (onSelect) (e.currentTarget as HTMLDivElement).style.background = 'rgba(37,99,235,0.04)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
          >
            <div style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              border: `2px solid ${stateColor}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              marginTop: 1,
            }}>
              {pr.state === 'MERGED' ? (
                <GitCommit size={10} strokeWidth={2.5} style={{ color: stateColor }} />
              ) : (
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: stateColor }} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: stateColor, fontWeight: 600, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                  #{pr.number}
                </span>
                <span style={{
                  fontSize: 13,
                  color: 'var(--t-text-strong)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}>
                  {pr.title}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 11, color: 'var(--t-text-muted)' }}>
                <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{pr.headRefName}</span>
                <span>·</span>
                <span style={{ color: '#22c55e', fontWeight: 600 }}>+{pr.additions}</span>
                <span style={{ color: '#ef4444', fontWeight: 600 }}>-{pr.deletions}</span>
                <span>·</span>
                <span>{pr.changedFiles} file{pr.changedFiles !== 1 ? 's' : ''}</span>
              </div>
              {pr.labels.length > 0 ? (
                <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                  {pr.labels.slice(0, 3).map((label) => (
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
                    }}>
                      {label.name}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <ChevronRight size={13} strokeWidth={2} style={{ color: 'var(--t-text-faint)', marginTop: 3, flexShrink: 0 }} />
          </div>
        );
      })}
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
          borderBottom: '1px solid var(--t-panel-border)',
          background: 'rgba(255,255,255,0.2)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
            {loading ? (
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text-secondary)' }}>Loading…</span>
            ) : detail ? (
              <>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#ef4444', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                  #{detail.number}
                </span>
                <span style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: 'var(--t-text)',
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
              border: '1px solid var(--t-btn-secondary-border)',
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
              borderBottom: '1px solid var(--t-divider-subtle)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              fontSize: 12,
              color: 'var(--t-text-secondary)',
            }}>
              <span>by <strong style={{ color: 'var(--t-text-strong)' }}>{detail.author}</strong></span>
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
                <p style={{ fontSize: '0.9rem', color: 'var(--t-text-muted)', fontStyle: 'italic' }}>
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

// ── CI List (light theme) ──

interface CIRunSummary {
  databaseId: number;
  displayTitle: string;
  headBranch: string;
  status: string;
  conclusion: string;
  createdAt: string;
  workflowName: string;
}

function ciStatusColor(conclusion: string, status: string): string {
  if (status === 'in_progress' || status === 'queued') return '#f59e0b';
  if (conclusion === 'success') return '#22c55e';
  if (conclusion === 'failure') return '#ef4444';
  if (conclusion === 'cancelled') return '#6b7280';
  return '#94a3b8';
}

function ciStatusIcon(conclusion: string, status: string): string {
  if (status === 'in_progress') return '◉';
  if (status === 'queued') return '○';
  if (conclusion === 'success') return '✓';
  if (conclusion === 'failure') return '✗';
  if (conclusion === 'cancelled') return '⊘';
  return '○';
}

function ciTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function CIList({ repo, onOpenCI }: { repo: string | null; onOpenCI?: (repo: string) => void }) {
  const [runs, setRuns] = useState<CIRunSummary[]>([]);
  const [loading, setLoading] = useState(true);

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

  if (loading) {
    return <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>Loading CI runs…</div>;
  }

  if (runs.length === 0) {
    return <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>No workflow runs found</div>;
  }

  return (
    <div style={{ paddingTop: 4, paddingBottom: 4 }}>
      {runs.map((run) => {
        const color = ciStatusColor(run.conclusion, run.status);
        const icon = ciStatusIcon(run.conclusion, run.status);
        return (
          <button
            key={run.databaseId}
            type="button"
            onClick={() => repo && onOpenCI?.(repo)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              width: '100%',
              paddingTop: 8,
              paddingRight: 14,
              paddingBottom: 8,
              paddingLeft: 14,
              border: 'none',
              borderBottom: '1px solid var(--t-divider-subtle)',
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            <span style={{
              fontSize: 14,
              color,
              fontWeight: 700,
              lineHeight: 1.3,
              flexShrink: 0,
              marginTop: 1,
            }}>{icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 12,
                fontWeight: 400,
                color: 'var(--t-text-strong)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>{run.displayTitle}</div>
              <div style={{
                fontSize: 10,
                color: 'var(--t-text-muted)',
                marginTop: 2,
                display: 'flex',
                gap: 4,
                alignItems: 'center',
              }}>
                <span style={{
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  fontSize: 10,
                }}>{run.headBranch}</span>
                <span>·</span>
                <span>{run.workflowName}</span>
                <span>·</span>
                <span>{ciTimeAgo(run.createdAt)}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Deploy List ──

interface DeploySummary {
  uid: string;
  name: string;
  url: string;
  state: string;
  created: number;
  target?: string;
  meta?: { githubCommitMessage?: string; githubCommitRef?: string };
}

function deployStatusColor(state: string): string {
  switch (state.toUpperCase()) {
    case 'READY': return '#22c55e';
    case 'BUILDING': case 'INITIALIZING': return '#f59e0b';
    case 'ERROR': case 'CANCELED': return '#ef4444';
    default: return '#94a3b8';
  }
}

function deployStatusIcon(state: string): string {
  switch (state.toUpperCase()) {
    case 'READY': return '●';
    case 'BUILDING': case 'INITIALIZING': return '◉';
    case 'ERROR': return '✗';
    case 'CANCELED': return '⊘';
    default: return '○';
  }
}

function DeployList({ onOpenDeploy }: { onOpenDeploy?: (project?: string) => void }) {
  const [deploys, setDeploys] = useState<DeploySummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/panel/deployments')
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setDeploys(data.deployments ?? []);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>Loading deployments…</div>;
  }

  if (deploys.length === 0) {
    return <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>No deployments found</div>;
  }

  return (
    <div style={{ paddingTop: 4, paddingBottom: 4 }}>
      {deploys.map((d) => {
        const color = deployStatusColor(d.state);
        const icon = deployStatusIcon(d.state);
        const age = ciTimeAgo(new Date(d.created).toISOString());
        return (
          <button
            key={d.uid}
            type="button"
            onClick={() => onOpenDeploy?.(d.name)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              width: '100%',
              paddingTop: 8,
              paddingRight: 14,
              paddingBottom: 8,
              paddingLeft: 14,
              border: 'none',
              borderBottom: '1px solid var(--t-divider-subtle)',
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            <span style={{ fontSize: 14, color, fontWeight: 700, lineHeight: 1.3, flexShrink: 0, marginTop: 1 }}>
              {icon}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 12,
                fontWeight: 400,
                color: 'var(--t-text-strong)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {d.meta?.githubCommitMessage || d.url}
              </div>
              <div style={{ fontSize: 10, color: 'var(--t-text-muted)', marginTop: 2, display: 'flex', gap: 4, alignItems: 'center' }}>
                <span style={{ fontWeight: 500, color: d.target === 'production' ? '#22c55e' : '#94a3b8' }}>
                  {d.target === 'production' ? 'prod' : 'preview'}
                </span>
                {d.meta?.githubCommitRef ? (
                  <>
                    <span>·</span>
                    <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{d.meta.githubCommitRef}</span>
                  </>
                ) : null}
                <span>·</span>
                <span>{age}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── File Tree (light theme) ──

function FileTreeNode({ node, depth = 0, changedFiles, onSelectFile }: {
  node: FileNode;
  depth?: number;
  changedFiles: Set<string>;
  onSelectFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0 || node.name === 'src');

  const isChanged = node.type === 'file' && changedFiles.has(node.path);

  // Check if any children (recursively) are changed
  const hasChangedChild = node.type === 'dir' && hasChangedDescendant(node, changedFiles);

  if (node.type === 'file') {
    return (
      <div
        onClick={() => onSelectFile?.(node.path)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 4,
          paddingRight: 14,
          paddingBottom: 4,
          paddingLeft: 14 + depth * 16,
          fontSize: 12,
          color: isChanged ? '#2563eb' : 'var(--t-text-secondary)',
          fontWeight: isChanged ? 500 : 400,
          fontFamily: '"SF Mono", ui-monospace, monospace',
          cursor: 'pointer',
          transition: 'color 100ms',
        }}
      >
        <FileText size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: isChanged ? '#3b82f6' : 'var(--t-text-muted)' }} />
        {node.name}
        {isChanged ? (
          <span style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: '#3b82f6',
            flexShrink: 0,
            marginLeft: 'auto',
          }} />
        ) : null}
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
          color: hasChangedChild ? '#1e40af' : 'var(--t-text)',
          cursor: 'pointer',
          transition: 'color 100ms',
        }}
      >
        {open
          ? <FolderOpen size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: hasChangedChild ? '#3b82f6' : '#3b82f6' }} />
          : <Folder size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: hasChangedChild ? '#3b82f6' : '#3b82f6' }} />
        }
        {node.name}
        {open
          ? <ChevronDown size={11} strokeWidth={2} style={{ color: 'var(--t-text-muted)' }} />
          : <ChevronRight size={11} strokeWidth={2} style={{ color: 'var(--t-text-muted)' }} />
        }
        {hasChangedChild && !open ? (
          <span style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: '#3b82f6',
            flexShrink: 0,
          }} />
        ) : null}
      </div>
      {open && node.children ? (
        node.children.map((child) => (
          <FileTreeNode key={child.path} node={child} depth={depth + 1} changedFiles={changedFiles} onSelectFile={onSelectFile} />
        ))
      ) : null}
    </div>
  );
}

function hasChangedDescendant(node: FileNode, changedFiles: Set<string>): boolean {
  if (node.type === 'file') return changedFiles.has(node.path);
  return node.children?.some(c => hasChangedDescendant(c, changedFiles)) ?? false;
}

const FileTree = memo(function FileTree({ tree, changedFiles, onSelectFile }: {
  tree: FileNode[];
  changedFiles: Set<string>;
  onSelectFile?: (path: string) => void;
}) {
  if (!tree.length) {
    return <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>No files found</div>;
  }

  return (
    <div style={{ paddingTop: 6, paddingBottom: 6 }}>
      {tree.map((node) => (
        <FileTreeNode key={node.path} node={node} changedFiles={changedFiles} onSelectFile={onSelectFile} />
      ))}
    </div>
  );
});

// ── Tab Bar ──

const tabs: { id: Tab; icon: typeof Zap; label: string }[] = [
  { id: 'activity', icon: Zap, label: 'Activity' },
  { id: 'issues', icon: Tag, label: 'Issues' },
  { id: 'prs', icon: GitCommit, label: 'PRs' },
  { id: 'files', icon: Folder, label: 'Files' },
  { id: 'ci', icon: PlayCircle, label: 'CI' },
  { id: 'deploy', icon: Globe, label: 'Deploy' },

];

// ── Memory Tab — auto-opens canvas on mount ──

function MemoryTabContent({ onOpenMemory }: { onOpenMemory?: () => void }) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (!firedRef.current && onOpenMemory) {
      firedRef.current = true;
      onOpenMemory();
    }
  }, [onOpenMemory]);

  return (
    <div style={{ padding: 14 }}>
      <button
        type="button"
        onClick={() => onOpenMemory?.()}
        style={{
          width: '100%',
          paddingTop: 12,
          paddingRight: 16,
          paddingBottom: 12,
          paddingLeft: 16,
          borderRadius: 10,
          border: '1px solid var(--t-panel-border)',
          background: 'linear-gradient(135deg, #0a0e1a 0%, #1e293b 100%)',
          color: '#e2e8f0',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}
      >
        <Cpu size={16} strokeWidth={1.8} style={{ color: '#3b82f6' }} />
        Open Memory Visualization
      </button>
      <p style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 8, lineHeight: 1.5 }}>
        Living particle view of Cortex knowledge. Heavy facts sink, fresh facts float. Hover to inspect.
      </p>
    </div>
  );
}

// ── Main Panel ──

export const AgentPanel = memo(function AgentPanel({
  onSelectSession,
  onSelectIssue,
  onSelectCommit,
  onSelectPR,
  onExpandWorkspace,
  onSelectFile,
  onOpenCI,
  onCreateIssue,
  onOpenGitLog,
  onOpenDeploy,
  onOpenMemory,
  onAgentsUpdate,
}: {
  onSelectSession?: (sessionKey: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
  onSelectCommit?: (hash: string) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onExpandWorkspace?: (workspace: string, repo: string | null) => void;
  onSelectFile?: (filePath: string, workspace?: string) => void;
  onOpenCI?: (repo: string) => void;
  onCreateIssue?: (repo?: string) => void;
  onOpenGitLog?: (workspace?: string) => void;
  onOpenDeploy?: (project?: string) => void;
  onOpenMemory?: () => void;
  onAgentsUpdate?: (agents: AgentDetail[]) => void;
} = {}) {
  const [agents, setAgents] = useState<AgentDetail[]>([]);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [commits, setCommits] = useState<{ hash: string; message: string; age: string }[]>([]);
  const [issues, setIssues] = useState<GHIssue[]>([]);
  const [prs, setPrs] = useState<GHPullRequest[]>([]);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<Tab>('activity');
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);

  // Build workspace groups from agents
  const workspaceGroups = buildWorkspaceGroups(agents);

  // Resolve workspace → GitHub repo when expanded group changes
  useEffect(() => {
    if (!expandedGroup) {
      setActiveRepo(null);
      setActiveWorkspace(null);
      return;
    }
    setActiveWorkspace(expandedGroup);
    // Resolve repo from workspace path
    fetch(`/api/panel/repo-info?workspace=${encodeURIComponent(expandedGroup)}`)
      .then(r => r.json())
      .then(data => {
        const repo = data.repo ?? null;
        setActiveRepo(repo);
        onExpandWorkspace?.(expandedGroup, repo);
      })
      .catch(() => setActiveRepo(null));
  }, [expandedGroup, onExpandWorkspace]);

  // Fetch agent inventory (agents + events)
  // Only update state when data actually changed (prevents flicker)
  useEffect(() => {
    async function fetchInventory() {
      try {
        const res = await fetch('/api/runtime/inventory');
        if (!res.ok) return;
        const data = await res.json();
        const newAgents = data.agents ?? [];
        setAgents(prev => JSON.stringify(prev) === JSON.stringify(newAgents) ? prev : newAgents);
        setEvents(prev => JSON.stringify(prev) === JSON.stringify(data.events ?? []) ? prev : (data.events ?? []));
        if (onAgentsUpdate) onAgentsUpdate(newAgents);
      } catch { /* silent */ }
    }
    void fetchInventory();
    const id = setInterval(fetchInventory, 30_000);
    return () => clearInterval(id);
  }, []);

  // Enrich agents with workspace/PR data
  useEffect(() => {
    if (agents.length === 0) return;
    async function fetchWorkspaces() {
      try {
        const res = await fetch('/api/panel/workspaces');
        if (!res.ok) return;
        const data = await res.json();
        const wsMap = new Map<string, { branch: string; pr: AgentDetail['pr']; localDiff: AgentDetail['localDiff']; activity: AgentDetail['activity']; workspaceStatus: AgentDetail['workspaceStatus'] }>();
        for (const ws of data.workspaces ?? []) {
          if (ws.sessionKey) {
            wsMap.set(ws.sessionKey, { branch: ws.branch, pr: ws.pr, localDiff: ws.localDiff, activity: ws.activity, workspaceStatus: ws.status });
          }
        }
        // Merge into agents
        setAgents(prev => {
          const enriched = prev.map(a => {
            const ws = wsMap.get(a.sessionKey);
            if (!ws) return a;
            return { ...a, branch: ws.branch, pr: ws.pr || undefined, localDiff: ws.localDiff || undefined, activity: ws.activity || undefined, workspaceStatus: ws.workspaceStatus };
          });
          return JSON.stringify(enriched) === JSON.stringify(prev) ? prev : enriched;
        });
      } catch { /* silent */ }
    }
    void fetchWorkspaces();
    const id = setInterval(fetchWorkspaces, 30_000);
    return () => clearInterval(id);
  }, [agents.length]);

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

  // Fetch GitHub issues (re-fetch when activeRepo changes)
  useEffect(() => {
    async function fetchIssues() {
      try {
        const repoParam = activeRepo ? `?repo=${encodeURIComponent(activeRepo)}` : '';
        const res = await fetch(`/api/panel/issues${repoParam}`);
        if (!res.ok) return;
        const data = await res.json();
        const fresh = data.issues ?? [];
        setIssues(prev => JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh);
      } catch { /* silent */ }
    }
    void fetchIssues();
    const id = setInterval(fetchIssues, 60_000);
    return () => clearInterval(id);
  }, [activeRepo]);

  // Fetch PRs (re-fetch when activeRepo changes)
  useEffect(() => {
    async function fetchPrs() {
      try {
        const repoParam = activeRepo ? `?repo=${encodeURIComponent(activeRepo)}` : '';
        const res = await fetch(`/api/panel/prs${repoParam}`);
        if (!res.ok) return;
        const data = await res.json();
        const fresh = data.prs ?? [];
        setPrs(prev => JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh);
      } catch { /* silent */ }
    }
    void fetchPrs();
    const id = setInterval(fetchPrs, 60_000);
    return () => clearInterval(id);
  }, [activeRepo]);

  // Fetch file tree (re-fetch when activeWorkspace changes)
  useEffect(() => {
    async function fetchFiles() {
      try {
        const wsParam = activeWorkspace ? `?workspace=${encodeURIComponent(activeWorkspace)}` : '';
        const res = await fetch(`/api/panel/files${wsParam}`);
        if (!res.ok) return;
        const data = await res.json();
        const freshTree = data.tree ?? [];
        setFileTree(prev => JSON.stringify(prev) === JSON.stringify(freshTree) ? prev : freshTree);
        const freshChanged = new Set<string>(data.changedFiles ?? []);
        setChangedFiles(prev => {
          const prevArr = Array.from(prev).sort();
          const newArr = Array.from(freshChanged).sort();
          return JSON.stringify(prevArr) === JSON.stringify(newArr) ? prev : freshChanged;
        });
      } catch { /* silent */ }
    }
    void fetchFiles();
    const id = setInterval(fetchFiles, 60_000);
    return () => clearInterval(id);
  }, [activeWorkspace]);

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'auto',
      scrollbarWidth: 'none',
      msOverflowStyle: 'none',
      WebkitOverflowScrolling: 'touch',
      background: 'var(--t-bg-subtle)',
    } as React.CSSProperties}
    className="hide-scrollbar"
    >
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
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(0,0,0,0.1) transparent',
      } as React.CSSProperties}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--t-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          paddingLeft: 2,
          marginBottom: 2,
        }}>
          Agents
        </div>
        {workspaceGroups.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--t-text-muted)', padding: '8px 2px' }}>Loading agents…</div>
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
                color: isActive ? 'var(--t-text)' : 'var(--t-text-muted)',
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

      {/* ── Scoped Context Label ── */}
      {activeTab !== 'activity' && expandedGroup ? (
        <div style={{
          paddingTop: 6,
          paddingRight: 14,
          paddingBottom: 4,
          paddingLeft: 14,
          fontSize: 11,
          color: 'var(--t-text-muted)',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          borderTop: '1px solid var(--t-divider-subtle)',
          marginTop: 4,
        }}>
          <span style={{ fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            {workspaceGroups.find(g => g.workspace === expandedGroup)?.displayName ?? 'All'}
          </span>
          {activeRepo ? (
            <>
              <span>·</span>
              <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{activeRepo}</span>
              <button
                type="button"
                onClick={() => onOpenGitLog?.(activeWorkspace ?? undefined)}
                title="View git history"
                style={{
                  marginLeft: 'auto',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  paddingTop: 2,
                  paddingRight: 6,
                  paddingBottom: 2,
                  paddingLeft: 6,
                  borderRadius: 4,
                  border: '1px solid var(--t-btn-secondary-border)',
                  background: 'var(--t-panel-hover)',
                  fontSize: 10,
                  color: 'var(--t-text-secondary)',
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  fontWeight: 500,
                }}
              >
                <GitCommit size={11} strokeWidth={2} />
                Log
              </button>
              <button
                type="button"
                onClick={() => onOpenCI?.(activeRepo)}
                title="View CI / GitHub Actions"
                style={{
                  marginLeft: 'auto',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  paddingTop: 2,
                  paddingRight: 6,
                  paddingBottom: 2,
                  paddingLeft: 6,
                  borderRadius: 4,
                  border: '1px solid var(--t-btn-secondary-border)',
                  background: 'var(--t-panel-hover)',
                  fontSize: 10,
                  color: 'var(--t-text-secondary)',
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  fontWeight: 500,
                }}
              >
                <PlayCircle size={11} strokeWidth={2} />
                CI
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {/* ── Content Area ── */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        borderTop: expandedGroup && activeTab !== 'activity' ? 'none' : '1px solid var(--t-divider-subtle)',
        marginTop: expandedGroup && activeTab !== 'activity' ? 0 : 4,
      }}>
        {activeTab === 'activity' ? <ActivityFeed events={events} commits={commits} onSelectCommit={onSelectCommit} /> : null}
        {activeTab === 'issues' ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 4,
              paddingLeft: 10,
              flexShrink: 0,
            }}>
              <button
                type="button"
                onClick={() => onCreateIssue?.(activeRepo ?? undefined)}
                title="Create new issue"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 4,
                  paddingRight: 8,
                  paddingBottom: 4,
                  paddingLeft: 8,
                  borderRadius: 6,
                  border: '1px solid var(--t-btn-secondary-border)',
                  background: 'var(--t-panel-hover)',
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--t-text-secondary)',
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                <Plus size={12} strokeWidth={2.5} />
                New
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <IssuesList issues={issues} onSelect={(num) => onSelectIssue ? onSelectIssue(num, activeRepo ?? undefined) : setSelectedIssue(num)} />
            </div>
          </div>
        ) : null}
        {activeTab === 'prs' ? <PRList prs={prs} onSelect={(num) => onSelectPR?.(num, activeRepo ?? undefined)} /> : null}
        {activeTab === 'files' ? <FileTree tree={fileTree} changedFiles={changedFiles} onSelectFile={(path) => onSelectFile?.(path, activeWorkspace ?? undefined)} /> : null}
        {activeTab === 'ci' ? <CIList repo={activeRepo} onOpenCI={onOpenCI} /> : null}
        {activeTab === 'deploy' ? <DeployList onOpenDeploy={onOpenDeploy} /> : null}

      </div>

      {/* ── Issue Detail Modal ── */}
      {selectedIssue !== null ? (
        <IssueModal issueNumber={selectedIssue} onClose={() => setSelectedIssue(null)} />
      ) : null}
      <style>{`
        @keyframes agentCardPulse {
          0%, 100% { border-color: rgba(147, 197, 253, 0.12); }
          50% { border-color: rgba(147, 197, 253, 0.06); }
        }
      `}</style>
    </div>
  );
});
