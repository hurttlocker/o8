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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDesktopWebSocket } from './hooks/useDesktopWebSocket';
import type { DesktopWsCallbacks } from './hooks/useDesktopWebSocket';
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
  GitBranch,
  GitCommit,
  GitPullRequest,
  Globe,
  MessageSquare,
  Monitor,
  PlayCircle,
  Plus,
  Radio,
  Tag,
  Terminal,
  X,
  XCircle,
  Zap,
  CheckCircle2,
} from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';
import { RepoRegistrySection } from './RepoRegistrySection';
import { WorktreeBadge } from '@/components/mobile/WorktreeBadge';
import { formatModelLabel } from '@/lib/format';
import type { WorktreeInfo } from '@/lib/worktree/types';

// ── Types ──

interface AgentDetail {
  id: string;
  name: string;
  squadId: string;
  model: string;
  primaryModel?: string;
  heartbeatModel?: string;
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
  tmuxSession?: string;
  worktree?: WorktreeInfo;
  // Agent lifecycle (from WS)
  lifecycleState?: 'active' | 'completed' | 'failed' | 'killed' | 'stalled';
  exitCode?: number;
  lifecycleTs?: number;
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

// formatModelLabel imported from @/lib/format

/** Smart model attribution for expanded agent cards */
function renderModelAttribution(agent: AgentDetail): React.ReactNode {
  const live = agent.model || '';
  const primary = agent.primaryModel;
  const heartbeat = agent.heartbeatModel;
  const surface = (agent.surfaceLabel || '').toLowerCase();

  const liveLabel = formatModelLabel(live);

  // Case D: Unexpected mismatch — live differs from both primary and heartbeat
  if (primary && live && live !== primary && live !== heartbeat) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: '#f59e0b', flexShrink: 0 }} />
        <span style={{ fontSize: 10, color: '#f59e0b', letterSpacing: '-0.01em' }}>{liveLabel}</span>
      </span>
    );
  }

  // Case C: Cron/automation surface
  if (surface.includes('cron') || surface.includes('automation')) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <Zap size={9} strokeWidth={2} style={{ color: 'var(--t-text-faint)' }} />
        <span style={{ fontSize: 10, color: 'var(--t-text-muted)', letterSpacing: '-0.01em' }}>{liveLabel}</span>
      </span>
    );
  }

  // Case B: Heartbeat run — live matches heartbeat but differs from primary
  if (primary && heartbeat && live === heartbeat && live !== primary) {
    const primaryLabel = formatModelLabel(primary);
    const hbLabel = formatModelLabel(heartbeat);
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-secondary)' }}>{primaryLabel}</span>
        <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
        <Clock size={9} strokeWidth={2} style={{ color: 'var(--t-text-faint)', flexShrink: 0 }} />
        <span style={{ fontSize: 10, color: 'var(--t-text-faint)', fontStyle: 'italic' }}>{hbLabel}</span>
      </span>
    );
  }

  // Case A: Normal — no primaryModel, or live matches primary
  if (!liveLabel) return null;
  return (
    <span style={{ fontSize: 10, color: 'var(--t-text-muted)', letterSpacing: '-0.01em' }}>
      {liveLabel}
    </span>
  );
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

function deriveRepo(workspace: string): string {
  const path = workspace.replace(/^~\//, '');

  // Unknown or empty workspace — group under OpenClaw
  if (!path || path === 'unknown') return 'openclaw';

  if (path.includes('/.cortex-worktrees/')) {
    const repoRoot = path.split('/.cortex-worktrees/')[0] ?? '';
    return repoRoot.split('/').pop() || 'openclaw';
  }
  if (path.includes('/.claude/worktrees/')) {
    const repoRoot = path.split('/.claude/worktrees/')[0] ?? '';
    return repoRoot.split('/').pop() || 'openclaw';
  }

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
    const repo = deriveRepo(workspace);
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
    const primary = wsAgents.find(a => !a.id.includes('cron') && !a.id.includes('discord') && !a.id.includes('telegram')) ?? wsAgents[0];
    const totalAlerts = wsAgents.reduce((sum, a) => sum + (a.alerts ?? 0), 0);

    groups.push({
      workspace,
      displayName,
      repo,
      agents: wsAgents,
      hasRunning,
      bestContextPct,
      primaryModel: primary?.primaryModel ?? primary?.model ?? '',
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
  onSelectPR,
  onAgentKill,
  lifecycleEvents,
}: {
  group: WorkspaceGroup;
  expanded: boolean;
  onToggle: () => void;
  onSelectSession?: (sessionKey: string) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onAgentKill?: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
  lifecycleEvents?: Map<string, { state: string; exitCode?: number; ts: number }>;
}) {
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
            {model && (
              <span style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--t-text-muted)',
                padding: '2px 6px',
                borderRadius: 999,
                background: 'var(--t-divider-subtle)',
                maxWidth: 150,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {formatModelLabel(model)}
              </span>
            )}
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
        type AgentStatus = 'in_progress' | 'in_review' | 'stalled' | 'completed' | 'failed' | 'idle';
        const classify = (a: AgentDetail): AgentStatus => {
          // Lifecycle state takes priority (from WS events)
          if (a.lifecycleState === 'stalled') return 'stalled';
          if (a.lifecycleState === 'completed') return 'completed';
          if (a.lifecycleState === 'failed' || a.lifecycleState === 'killed') return 'failed';
          // Use workspace status if available (PR-aware)
          if (a.workspaceStatus === 'in_review') return 'in_review';
          if (a.workspaceStatus === 'done') return 'completed';
          if (a.status === 'running' || a.status === 'watching' || a.status === 'healthy') return 'in_progress';
          return 'idle';
        };
        const statusGroups: { key: AgentStatus; label: string; color: string; agents: AgentDetail[] }[] = [
          { key: 'in_progress', label: 'In Progress', color: '#2563eb', agents: [] },
          { key: 'stalled', label: 'Stalled', color: '#f97316', agents: [] },
          { key: 'in_review', label: 'In Review', color: '#f59e0b', agents: [] },
          { key: 'failed', label: 'Failed', color: '#ef4444', agents: [] },
          { key: 'completed', label: 'Completed', color: '#22c55e', agents: [] },
          { key: 'idle', label: 'Idle', color: '#9ca3af', agents: [] },
        ];
        for (const agent of group.agents) {
          const status = classify(agent);
          statusGroups.find(g => g.key === status)?.agents.push(agent);
        }

        const renderCard = (agent: AgentDetail) => {
          // Merge lifecycle events from WS into agent
          const lc = lifecycleEvents?.get(agent.tmuxSession ?? '') ?? lifecycleEvents?.get(agent.sessionKey ?? '');
          const lcState = lc?.state as AgentDetail['lifecycleState'] | undefined;
          const lcExitCode = lc?.exitCode;
          const lcTs = lc?.ts;

          const isRunning = (agent.status === 'running' || agent.status === 'watching' || agent.status === 'healthy')
            && lcState !== 'completed' && lcState !== 'failed' && lcState !== 'killed' && lcState !== 'stalled';
          const isFailed = lcState === 'failed' || lcState === 'killed';
          const isCompleted = lcState === 'completed';
          const isStalled = lcState === 'stalled';
          const agentDot = isFailed ? '#ef4444' : isStalled ? '#f97316' : isCompleted ? '#22c55e' : isRunning ? '#22c55e' : '#9ca3af';
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
          const modelAttribution = renderModelAttribution(agent);
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
                  ? '1px solid rgba(52, 211, 153, 0.2)'
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
                if (agent.status === 'running') {
                  e.currentTarget.style.border = '';
                  e.currentTarget.style.boxShadow = '';
                } else {
                  e.currentTarget.style.border = '1px solid var(--t-panel-border)';
                  e.currentTarget.style.boxShadow = 'none';
                }
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
                    {modelAttribution}
                    {branch && !branch.startsWith('surface/') && (
                      <>
                        <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 3,
                          fontSize: 10, color: 'var(--t-text-secondary)',
                          fontFamily: 'SF Mono, Menlo, monospace',
                          maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          padding: '1px 5px', borderRadius: 4,
                          background: 'rgba(37,99,235,0.04)',
                          border: '1px solid rgba(37,99,235,0.08)',
                        }}>
                          <GitBranch size={9} strokeWidth={2} style={{ flexShrink: 0 }} />
                          {branch}
                        </span>
                      </>
                    )}
                    {pr && (
                      <>
                        <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                        <span
                          onClick={(e) => { e.stopPropagation(); onSelectPR?.(pr.number, group.repo); }}
                          style={{
                            fontSize: 10, fontWeight: 600,
                            color: pr.state === 'merged' ? '#8b5cf6' : pr.state === 'open' ? '#22c55e' : '#9ca3af',
                            cursor: 'pointer',
                          }}
                          title={`View PR #${pr.number}`}
                        >
                          #{pr.number}
                        </span>
                      </>
                    )}
                  </div>
                  {agent.worktree ? (
                    <div style={{ marginTop: 4 }}>
                      <WorktreeBadge worktree={agent.worktree} />
                    </div>
                  ) : null}
                </div>
                {/* Right side: diff stats + context ring */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 'auto' }}>
                  {diff && (
                    <span
                      onClick={pr ? (e) => { e.stopPropagation(); onSelectPR?.(pr.number, group.repo); } : undefined}
                      style={{
                        fontSize: 10, fontWeight: 700,
                        fontFamily: 'SF Mono, Menlo, monospace',
                        display: 'flex', gap: 4, flexShrink: 0,
                        cursor: pr ? 'pointer' : 'default',
                        padding: pr ? '2px 6px' : 0,
                        borderRadius: pr ? 6 : 0,
                        background: pr ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                        transition: 'background 120ms ease',
                      }}
                      onMouseEnter={pr ? (e) => { e.currentTarget.style.background = 'rgba(37, 99, 235, 0.12)'; } : undefined}
                      onMouseLeave={pr ? (e) => { e.currentTarget.style.background = 'rgba(37, 99, 235, 0.06)'; } : undefined}
                      title={pr ? `View PR #${pr.number} diff` : undefined}
                    >
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

              {/* Lifecycle status line + actions */}
              {(isRunning || isFailed || isCompleted || isStalled) && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginTop: 8, paddingTop: 8,
                  borderTop: '1px solid var(--t-divider-subtle)',
                }}>
                  <span style={{
                    fontSize: 10, fontWeight: 600, flex: 1,
                    color: isFailed ? '#ef4444' : isStalled ? '#f97316' : isCompleted ? '#22c55e' : 'var(--t-text-secondary)',
                  }}>
                    {isFailed
                      ? `${lcState === 'killed' ? 'Killed' : 'Failed'}${lcExitCode !== undefined ? ` (exit ${lcExitCode})` : ''}`
                      : isStalled
                        ? `Stalled — no output for ${lcTs ? `${Math.round((Date.now() - lcTs) / 60000)}m` : '5m+'}`
                      : isCompleted
                        ? `Completed${lcTs ? ` · ${Math.round((Date.now() - lcTs) / 60000)}m ago` : ''}`
                        : 'Running'
                    }
                  </span>
                  {(isRunning || isStalled) && onAgentKill && agent.tmuxSession && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onAgentKill(agent.tmuxSession!, 'SIGINT');
                      }}
                      style={{
                        fontSize: 9, fontWeight: 700, padding: '3px 8px',
                        borderRadius: 6, border: '1px solid rgba(245, 158, 11, 0.3)',
                        background: 'rgba(245, 158, 11, 0.08)', color: '#f59e0b',
                        cursor: 'pointer', letterSpacing: '0.02em',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(245, 158, 11, 0.15)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(245, 158, 11, 0.08)'; }}
                      title="Send interrupt (Ctrl+C)"
                    >
                      INTERRUPT
                    </button>
                  )}
                  {(isRunning || isStalled) && onAgentKill && agent.tmuxSession && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm('Kill this agent? This will terminate it immediately.')) {
                          onAgentKill(agent.tmuxSession!);
                        }
                      }}
                      style={{
                        fontSize: 9, fontWeight: 700, padding: '3px 8px',
                        borderRadius: 6, border: '1px solid rgba(239, 68, 68, 0.3)',
                        background: 'rgba(239, 68, 68, 0.08)', color: '#ef4444',
                        cursor: 'pointer', letterSpacing: '0.02em',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'; }}
                      title="Kill agent (SIGTERM)"
                    >
                      STOP
                    </button>
                  )}
                  {isFailed && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // TODO: Wire retry — relaunch same agent config
                      }}
                      style={{
                        fontSize: 9, fontWeight: 700, padding: '3px 8px',
                        borderRadius: 6, border: '1px solid rgba(37, 99, 235, 0.3)',
                        background: 'rgba(37, 99, 235, 0.08)', color: '#2563eb',
                        cursor: 'pointer', letterSpacing: '0.02em',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(37, 99, 235, 0.15)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(37, 99, 235, 0.08)'; }}
                      title="Retry with same configuration"
                    >
                      RETRY
                    </button>
                  )}
                </div>
              )}
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

// ── Unified Activity Feed (Apple-grade) ──

type ActivityItem =
  | { kind: 'commit'; hash: string; message: string; age: string; ts: number }
  | { kind: 'event'; data: EventEntry; ts: number }
  | { kind: 'issue'; number: number; title: string; state: string; labels: { name: string; color: string }[]; age: string; ts: number }
  | { kind: 'pr'; number: number; title: string; state: string; author: string; branch: string; additions: number; deletions: number; age: string; ts: number }
  | { kind: 'ci'; id: number; title: string; status: string; conclusion: string; branch: string; workflow: string; age: string; ts: number };

function relativeAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const FEED_ICON: Record<string, { icon: React.ReactNode; bg: string; color: string }> = {
  commit: { icon: <GitCommit size={11} strokeWidth={2} />, bg: 'rgba(34,197,94,0.08)', color: '#22c55e' },
  issue: { icon: <AlertCircle size={11} strokeWidth={2} />, bg: 'rgba(139,92,246,0.08)', color: '#8b5cf6' },
  pr: { icon: <GitPullRequest size={11} strokeWidth={2} />, bg: 'rgba(37,99,235,0.08)', color: '#2563eb' },
  ci_success: { icon: <CheckCircle2 size={11} strokeWidth={2} />, bg: 'rgba(34,197,94,0.08)', color: '#22c55e' },
  ci_failure: { icon: <XCircle size={11} strokeWidth={2} />, bg: 'rgba(239,68,68,0.08)', color: '#ef4444' },
  ci_pending: { icon: <Clock size={11} strokeWidth={2} />, bg: 'rgba(245,158,11,0.08)', color: '#f59e0b' },
  event: { icon: <Zap size={11} strokeWidth={2} />, bg: 'rgba(100,116,139,0.08)', color: '#64748b' },
};

function feedIcon(item: ActivityItem) {
  if (item.kind === 'ci') {
    if (item.conclusion === 'success') return FEED_ICON.ci_success;
    if (item.conclusion === 'failure') return FEED_ICON.ci_failure;
    return FEED_ICON.ci_pending;
  }
  if (item.kind === 'event') {
    const sColor = severityColor[item.data.severity] ?? '#64748b';
    return { icon: <Zap size={11} strokeWidth={2} />, bg: `${sColor}10`, color: sColor };
  }
  return FEED_ICON[item.kind] ?? FEED_ICON.event;
}

type FeedFilter = 'all' | 'commit' | 'issue' | 'pr' | 'ci';

const FILTER_TABS: { key: FeedFilter; label: string; icon: React.ReactNode }[] = [
  { key: 'all', label: 'All', icon: <Zap size={11} strokeWidth={2} /> },
  { key: 'commit', label: 'Commits', icon: <GitCommit size={11} strokeWidth={2} /> },
  { key: 'issue', label: 'Issues', icon: <AlertCircle size={11} strokeWidth={2} /> },
  { key: 'pr', label: 'PRs', icon: <GitPullRequest size={11} strokeWidth={2} /> },
  { key: 'ci', label: 'CI', icon: <CheckCircle2 size={11} strokeWidth={2} /> },
];

// Agent → GitHub repo mapping (same as workspaces API)
const AGENT_REPO_MAP: Record<string, string> = {
  'agent:main:main': 'hurttlocker/cortex-ide',
  'agent:ace:main': 'hurttlocker/cortex',
  'agent:hawk:main': 'hurttlocker/cortex',
};

// Display names for repos
const REPO_DISPLAY: Record<string, string> = {
  'hurttlocker/cortex-ide': 'Cortex IDE',
  'hurttlocker/cortex': 'Cortex',
  'hurttlocker/sleeping-beauties': 'Copy Trade',
};

const FALLBACK_REPOS = Object.keys(REPO_DISPLAY);

// Special "all repos" key
const ALL_REPOS_KEY = '__github__';

const ActivityFeed = memo(function ActivityFeed({
  events,
  commits,
  onSelectCommit,
  onSelectPR,
  activeRepo: externalRepo,
  activeAgentKey,
  refreshKey,
}: {
  events: EventEntry[];
  commits: { hash: string; message: string; age: string }[];
  onSelectCommit?: (hash: string) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  activeRepo?: string | null;
  activeAgentKey?: string | null;
  refreshKey?: number;
}) {
  const [extras, setExtras] = useState<{ issues: ActivityItem[]; prs: ActivityItem[]; ciRuns: ActivityItem[]; repoCommits: ActivityItem[] }>({ issues: [], prs: [], ciRuns: [], repoCommits: [] });
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [repoOverride, setRepoOverride] = useState<string | null>(null);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [registeredRepos, setRegisteredRepos] = useState<string[]>([]);

  // Fetch registered repos on mount
  useEffect(() => {
    fetch('/api/panel/repos')
      .then(r => r.json())
      .then(data => {
        const ghRepos = (data.repos ?? [])
          .map((r: { remoteUrl?: string }) => {
            const url = (r.remoteUrl ?? '').replace(/\.git$/, '');
            const parts = url.split('/');
            return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
          })
          .filter(Boolean) as string[];
        setRegisteredRepos(ghRepos);
      })
      .catch(() => {});
  }, []);

  // Merge registered repos with known repos (deduped)
  const allRepos = useMemo(() => {
    const set = new Set([...registeredRepos, ...FALLBACK_REPOS]);
    return Array.from(set);
  }, [registeredRepos]);

  // Resolve active repo: override > agent-derived > external > default
  const repo = useMemo(() => {
    if (repoOverride) return repoOverride;
    if (activeAgentKey && AGENT_REPO_MAP[activeAgentKey]) return AGENT_REPO_MAP[activeAgentKey];
    if (externalRepo) return externalRepo;
    return 'hurttlocker/cortex-ide';
  }, [repoOverride, activeAgentKey, externalRepo]);

  const isAllRepos = repo === ALL_REPOS_KEY;
  const repoLabel = isAllRepos ? 'GitHub' : (REPO_DISPLAY[repo] ?? repo.split('/').pop() ?? repo);

  // Clear override when agent changes
  useEffect(() => { setRepoOverride(null); }, [activeAgentKey]);

  // Fetch issues, PRs, CI, and commits for selected repo(s)
  useEffect(() => {
    async function fetchForRepo(r: string) {
      const [issuesRes, prsRes, ciRes, commitsRes] = await Promise.all([
        fetch(`/api/panel/issues?repo=${encodeURIComponent(r)}`).catch(() => null),
        fetch(`/api/panel/prs?repo=${encodeURIComponent(r)}`).catch(() => null),
        fetch(`/api/panel/ci?repo=${encodeURIComponent(r)}`).catch(() => null),
        fetch(`/api/panel/commits?repo=${encodeURIComponent(r)}`).catch(() => null),
      ]);

      const repoSlug = r.split('/').pop() ?? r;
      const issueItems: ActivityItem[] = [];
      if (issuesRes?.ok) {
        const data = await issuesRes.json();
        for (const i of (data.issues ?? []).slice(0, 8)) {
          const ts = i.createdAt ? new Date(i.createdAt).getTime() : 0;
          issueItems.push({ kind: 'issue', number: i.number, title: i.title, state: (i.state ?? '').toLowerCase(), labels: i.labels ?? [], age: i.createdAt ? relativeAge(i.createdAt) : '', ts });
        }
      }

      const prItems: ActivityItem[] = [];
      if (prsRes?.ok) {
        const data = await prsRes.json();
        for (const p of (data.prs ?? []).slice(0, 8)) {
          const ts = p.createdAt ? new Date(p.createdAt).getTime() : 0;
          prItems.push({ kind: 'pr', number: p.number, title: p.title, state: (p.state ?? '').toLowerCase(), author: p.author?.login ?? '', branch: p.headRefName ?? '', additions: p.additions ?? 0, deletions: p.deletions ?? 0, age: p.createdAt ? relativeAge(p.createdAt) : '', ts });
        }
      }

      const ciItems: ActivityItem[] = [];
      if (ciRes?.ok) {
        const data = await ciRes.json();
        for (const c of (data.runs ?? []).slice(0, 6)) {
          const ts = c.createdAt ? new Date(c.createdAt).getTime() : 0;
          ciItems.push({ kind: 'ci', id: c.databaseId, title: c.displayTitle ?? '', status: c.status ?? '', conclusion: c.conclusion ?? '', branch: c.headBranch ?? '', workflow: c.workflowName ?? '', age: c.createdAt ? relativeAge(c.createdAt) : '', ts });
        }
      }

      const commitItems: ActivityItem[] = [];
      if (commitsRes?.ok) {
        const data = await commitsRes.json();
        for (const c of (data.commits ?? []).slice(0, 10)) {
          const ts = c.date ? new Date(c.date).getTime() : 0;
          commitItems.push({ kind: 'commit', hash: c.hash ?? '', message: `${isAllRepos ? `[${repoSlug}] ` : ''}${c.message ?? ''}`, age: c.date ? relativeAge(c.date) : '', ts });
        }
      }

      return { issues: issueItems, prs: prItems, ciRuns: ciItems, commits: commitItems };
    }

    async function fetchExtras() {
      try {
        if (isAllRepos) {
          // Fetch from all registered repos in parallel
          const repos = allRepos.length > 0 ? allRepos : FALLBACK_REPOS;
          const results = await Promise.all(repos.map(r => fetchForRepo(r).catch(() => ({ issues: [], prs: [], ciRuns: [], commits: [] }))));
          const merged = { issues: [] as ActivityItem[], prs: [] as ActivityItem[], ciRuns: [] as ActivityItem[], repoCommits: [] as ActivityItem[] };
          for (const r of results) {
            merged.issues.push(...r.issues);
            merged.prs.push(...r.prs);
            merged.ciRuns.push(...r.ciRuns);
            merged.repoCommits.push(...r.commits);
          }
          setExtras(merged);
        } else {
          const result = await fetchForRepo(repo);
          setExtras({ issues: result.issues, prs: result.prs, ciRuns: result.ciRuns, repoCommits: result.commits });
        }
      } catch { /* silent */ }
    }
    fetchExtras();
    const id = setInterval(fetchExtras, 60_000);
    return () => clearInterval(id);
  }, [repo, isAllRepos, allRepos, refreshKey]);

  // Build unified timeline — commits now come from per-repo fetch, not parent prop
  const items = useMemo<ActivityItem[]>(() => {
    const all: ActivityItem[] = [];

    // Repo-specific commits from API
    all.push(...extras.repoCommits);

    // Agent events (always included — they're cross-repo)
    for (const e of events) {
      const ts = e.timestamp ? new Date(e.timestamp).getTime() || Date.now() : Date.now();
      all.push({ kind: 'event', data: e, ts });
    }

    all.push(...extras.issues, ...extras.prs, ...extras.ciRuns);

    // Sort newest first
    all.sort((a, b) => b.ts - a.ts);
    return all.slice(0, 40);
  }, [events, extras]);

  // Counts per type for filter badges
  const counts = useMemo(() => {
    const c: Record<FeedFilter, number> = { all: items.length, commit: 0, issue: 0, pr: 0, ci: 0 };
    for (const item of items) {
      if (item.kind === 'event') continue; // events show in 'all' only
      if (item.kind in c) c[item.kind as FeedFilter]++;
    }
    return c;
  }, [items]);

  // Apply filter
  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter(i => i.kind === filter);
  }, [items, filter]);

  // Group by date
  const grouped = useMemo(() => {
    const groups: { label: string; items: ActivityItem[] }[] = [];
    let currentLabel = '';
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    for (const item of filtered) {
      const d = new Date(item.ts).toDateString();
      const label = d === today ? 'Today' : d === yesterday ? 'Yesterday' : new Date(item.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (label !== currentLabel) {
        groups.push({ label, items: [] });
        currentLabel = label;
      }
      groups[groups.length - 1].items.push(item);
    }
    return groups;
  }, [filtered]);

  if (!items.length) {
    return (
      <div style={{ padding: '24px 14px', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--t-text-muted)', fontWeight: 500 }}>No recent activity</div>
        <div style={{ fontSize: 11, color: 'var(--t-text-faint)', marginTop: 4 }}>Commits, issues, PRs, and CI runs will appear here</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Repo selector + filter tabs — Apple toolbar style */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 3,
        background: 'var(--t-panel)',
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}>
        {/* Repo selector row */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 10px 4px',
        }}>
          <button
            type="button"
            onClick={() => setRepoPickerOpen(v => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 8px 3px 6px',
              borderRadius: 8,
              border: '1px solid var(--t-divider-subtle)',
              background: 'rgba(255, 255, 255, 0.6)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
            }}
          >
            <Folder size={11} strokeWidth={2} style={{ color: '#2563eb' }} />
            {repoLabel}
            <ChevronDown size={10} strokeWidth={2} style={{
              color: 'var(--t-text-muted)',
              transform: repoPickerOpen ? 'rotate(180deg)' : 'none',
              transition: 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)',
            }} />
          </button>

          {/* Merge banner — only if there's an open PR on this repo */}
          {extras.prs.some(p => p.kind === 'pr' && (p.state === 'open')) ? (() => {
            const openPr = extras.prs.find(p => p.kind === 'pr' && p.state === 'open') as (ActivityItem & { kind: 'pr' }) | undefined;
            if (!openPr) return null;
            return (
              <div style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}>
                <span style={{
                  fontSize: 10,
                  color: 'var(--t-text-muted)',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                }}>
                  PR #{openPr.number}
                </span>
                <button
                  type="button"
                  onClick={() => onSelectPR?.(openPr.number, repo)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 10px',
                    borderRadius: 8,
                    border: 'none',
                    background: '#22c55e',
                    color: '#fff',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    letterSpacing: '-0.01em',
                  }}
                >
                  <GitPullRequest size={10} strokeWidth={2.5} />
                  Review
                </button>
              </div>
            );
          })() : null}
        </div>

        {/* Repo picker dropdown */}
        {repoPickerOpen ? (
          <div
            style={{
              margin: '2px 10px 6px',
              borderRadius: 10,
              border: '1px solid var(--t-divider-subtle)',
              background: 'rgba(255, 255, 255, 0.95)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
              maxHeight: 200,
              overflowY: 'auto',
              scrollbarWidth: 'none',
            } as React.CSSProperties}
            className="hide-scrollbar"
          >
            {/* GitHub (all repos) option */}
            {(() => {
              const selected = isAllRepos;
              return (
                <button
                  type="button"
                  onClick={() => { setRepoOverride(ALL_REPOS_KEY); setRepoPickerOpen(false); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '7px 12px',
                    border: 'none',
                    borderBottom: '1px solid var(--t-divider-subtle)',
                    background: selected ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                    color: selected ? '#2563eb' : 'var(--t-text)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    textAlign: 'left',
                  }}
                >
                  <Globe size={12} strokeWidth={2} style={{ color: selected ? '#2563eb' : 'var(--t-text-muted)' }} />
                  GitHub
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: 9,
                    color: 'var(--t-text-faint)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}>
                    all repos
                  </span>
                  {selected ? <CheckCircle2 size={12} strokeWidth={2} style={{ color: '#2563eb' }} /> : null}
                </button>
              );
            })()}
            {/* Individual repos */}
            {allRepos.map((r) => {
              const selected = r === repo && !isAllRepos;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => { setRepoOverride(r); setRepoPickerOpen(false); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '7px 12px',
                    border: 'none',
                    background: selected ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                    color: selected ? '#2563eb' : 'var(--t-text)',
                    fontSize: 12,
                    fontWeight: selected ? 600 : 400,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    textAlign: 'left',
                  }}
                >
                  <Folder size={12} strokeWidth={2} style={{ color: selected ? '#2563eb' : 'var(--t-text-muted)' }} />
                  {REPO_DISPLAY[r] ?? r.split('/').pop()}
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: 9,
                    color: 'var(--t-text-faint)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}>
                    {r.split('/').pop()}
                  </span>
                  {selected ? <CheckCircle2 size={12} strokeWidth={2} style={{ color: '#2563eb' }} /> : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Filter tabs */}
        <div style={{
          display: 'flex',
          gap: 1,
          padding: '2px 10px 6px',
        }}>
          {FILTER_TABS.map((tab) => {
            const active = filter === tab.key;
            const count = counts[tab.key];
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilter(tab.key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px',
                  borderRadius: 8,
                  border: 'none',
                  background: active ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                  color: active ? '#2563eb' : 'var(--t-text-muted)',
                  fontSize: 10,
                  fontWeight: active ? 700 : 500,
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  transition: 'all 150ms cubic-bezier(0.32, 0.72, 0, 1)',
                }}
              >
                {tab.icon}
                {tab.label}
                {count > 0 && tab.key !== 'all' ? (
                  <span style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: active ? '#2563eb' : 'var(--t-text-faint)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}>
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* No results for filter */}
      {filtered.length === 0 ? (
        <div style={{ padding: '16px 14px', fontSize: 11, color: 'var(--t-text-muted)', textAlign: 'center' }}>
          No {filter === 'all' ? '' : filter} activity
        </div>
      ) : null}

      {grouped.map((group) => (
        <div key={group.label}>
          {/* Date header */}
          <div style={{
            padding: '6px 14px 3px',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--t-text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            position: 'sticky',
            top: 68,
            background: 'var(--t-panel)',
            zIndex: 2,
          }}>
            {group.label}
          </div>
          {group.items.map((item, idx) => {
            const fi = feedIcon(item);
            const key = item.kind === 'commit' ? `c-${item.hash}` : item.kind === 'event' ? `e-${item.data.id}` : item.kind === 'issue' ? `i-${item.number}` : item.kind === 'pr' ? `pr-${item.number}` : `ci-${item.id}`;
            const clickable = (item.kind === 'commit' && !!onSelectCommit) || item.kind === 'issue' || item.kind === 'pr' || item.kind === 'ci';
            const handleClick = () => {
              if (item.kind === 'commit') { onSelectCommit?.(item.hash); return; }
              // PRs open in contextual canvas
              if (item.kind === 'pr') { onSelectPR?.(item.number, repo); return; }
              // Issues/CI open in browser
              let url = '';
              if (item.kind === 'issue') url = `https://github.com/${repo}/issues/${item.number}`;
              else if (item.kind === 'ci') url = `https://github.com/${repo}/actions/runs/${item.id}`;
              if (url) window.open(url, '_blank');
            };

            return (
              <div
                key={key}
                onClick={clickable ? handleClick : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '7px 14px',
                  cursor: clickable ? 'pointer' : 'default',
                  transition: 'background 100ms ease',
                }}
                onMouseEnter={clickable ? (e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(37,99,235,0.04)'; } : undefined}
                onMouseLeave={clickable ? (e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; } : undefined}
              >
                {/* Icon dot */}
                <div style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: fi.bg,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  marginTop: 1,
                  color: fi.color,
                }}>
                  {fi.icon}
                </div>

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Title line */}
                  <div style={{
                    fontSize: 12,
                    color: 'var(--t-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: 1.4,
                    fontWeight: 500,
                  }}>
                    {item.kind === 'commit' ? item.message : item.kind === 'event' ? item.data.title : item.kind === 'issue' ? `#${item.number} ${item.title}` : item.kind === 'pr' ? `#${item.number} ${item.title}` : item.title}
                  </div>

                  {/* Metadata line */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginTop: 1,
                    fontSize: 10,
                    color: 'var(--t-text-muted)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    lineHeight: 1.4,
                  }}>
                    {item.kind === 'commit' ? (
                      <>
                        <span style={{ color: 'var(--t-text-secondary)' }}>{item.hash}</span>
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span>{item.age}</span>
                      </>
                    ) : item.kind === 'pr' ? (
                      <>
                        <span style={{ color: '#22c55e' }}>+{item.additions}</span>
                        <span style={{ color: '#ef4444' }}>-{item.deletions}</span>
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span>{item.branch}</span>
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span>{item.age}</span>
                      </>
                    ) : item.kind === 'ci' ? (
                      <>
                        <span>{item.workflow}</span>
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span>{item.branch}</span>
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span style={{
                          color: item.conclusion === 'success' ? '#22c55e' : item.conclusion === 'failure' ? '#ef4444' : '#f59e0b',
                          fontWeight: 600,
                        }}>
                          {item.conclusion || item.status}
                        </span>
                      </>
                    ) : item.kind === 'issue' ? (
                      <>
                        {item.labels.slice(0, 2).map((l) => (
                          <span key={l.name} style={{
                            padding: '0 4px',
                            borderRadius: 4,
                            background: `#${l.color}18`,
                            color: `#${l.color}`,
                            fontSize: 9,
                            fontWeight: 600,
                            fontFamily: '-apple-system, system-ui, sans-serif',
                          }}>
                            {l.name}
                          </span>
                        ))}
                        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                        <span>{item.age}</span>
                      </>
                    ) : (
                      <span>{item.data.timestamp}</span>
                    )}
                  </div>
                </div>

                {/* Right side badges */}
                {item.kind === 'pr' && item.state ? (
                  <span style={{
                    padding: '1px 6px',
                    borderRadius: 999,
                    fontSize: 9,
                    fontWeight: 700,
                    flexShrink: 0,
                    marginTop: 2,
                    background: item.state === 'merged' ? 'rgba(139,92,246,0.1)' : item.state === 'open' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                    color: item.state === 'merged' ? '#8b5cf6' : item.state === 'open' ? '#22c55e' : '#ef4444',
                    textTransform: 'uppercase',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}>
                    {item.state}
                  </span>
                ) : null}
                {item.kind === 'issue' && item.state ? (
                  <span style={{
                    padding: '1px 6px',
                    borderRadius: 999,
                    fontSize: 9,
                    fontWeight: 700,
                    flexShrink: 0,
                    marginTop: 2,
                    background: item.state === 'open' ? 'rgba(34,197,94,0.1)' : 'rgba(139,92,246,0.1)',
                    color: item.state === 'open' ? '#22c55e' : '#8b5cf6',
                    textTransform: 'uppercase',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}>
                    {item.state}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
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

// ── File icon color mapping (VS Code / Cursor style) ──
const FILE_ICON_COLORS: Record<string, string> = {
  // TypeScript / JavaScript
  '.ts': '#3178c6', '.tsx': '#3178c6', '.d.ts': '#3178c6',
  '.js': '#f7df1e', '.jsx': '#f7df1e', '.mjs': '#f7df1e', '.cjs': '#f7df1e',
  // Styles
  '.css': '#1572b6', '.scss': '#cd6799', '.less': '#1d365d', '.sass': '#cd6799',
  // Data / Config
  '.json': '#cbcb41', '.yaml': '#cb171e', '.yml': '#cb171e', '.toml': '#9c4121',
  '.xml': '#e37933', '.csv': '#237346',
  // Web
  '.html': '#e34f26', '.htm': '#e34f26', '.svg': '#ffb13b',
  // Docs
  '.md': '#519aba', '.mdx': '#519aba', '.txt': '#89929b',
  // Go
  '.go': '#00add8', '.mod': '#00add8', '.sum': '#00add8',
  // Rust
  '.rs': '#ce412b',
  // Python
  '.py': '#3572a5', '.pyi': '#3572a5',
  // Shell
  '.sh': '#4eaa25', '.bash': '#4eaa25', '.zsh': '#4eaa25', '.fish': '#4eaa25',
  // Images
  '.png': '#a074c4', '.jpg': '#a074c4', '.jpeg': '#a074c4', '.gif': '#a074c4',
  '.ico': '#a074c4', '.webp': '#a074c4',
  // Lock/Config
  '.lock': '#89929b', '.env': '#ecd53f', '.gitignore': '#f05032',
  // Other
  '.wasm': '#654ff0', '.sql': '#e38c00', '.graphql': '#e535ab', '.prisma': '#2d3748',
};

// Special filename → color
const FILE_NAME_COLORS: Record<string, string> = {
  'package.json': '#3c873a', 'package-lock.json': '#3c873a',
  'tsconfig.json': '#3178c6', 'next.config.js': '#000000', 'next.config.ts': '#000000', 'next.config.mjs': '#000000',
  'tailwind.config.js': '#38bdf8', 'tailwind.config.ts': '#38bdf8',
  'postcss.config.js': '#dd3a0a', 'postcss.config.mjs': '#dd3a0a',
  '.eslintrc': '#4b32c3', '.eslintrc.js': '#4b32c3', '.eslintrc.json': '#4b32c3', 'eslint.config.js': '#4b32c3', 'eslint.config.mjs': '#4b32c3',
  '.prettierrc': '#56b3b4', 'prettier.config.js': '#56b3b4',
  'Dockerfile': '#2496ed', 'docker-compose.yml': '#2496ed', 'docker-compose.yaml': '#2496ed',
  'Makefile': '#6d8086', 'CMakeLists.txt': '#6d8086',
  'README.md': '#519aba', 'LICENSE': '#d4aa00', 'CHANGELOG.md': '#519aba',
  'Cargo.toml': '#ce412b', 'Cargo.lock': '#ce412b',
  'go.mod': '#00add8', 'go.sum': '#00add8',
  '.env': '#ecd53f', '.env.local': '#ecd53f', '.env.example': '#ecd53f', '.env.development': '#ecd53f',
  '.gitignore': '#f05032', '.gitattributes': '#f05032',
  'jest.config.js': '#c21325', 'jest.config.ts': '#c21325', 'vitest.config.ts': '#729b1b',
  'CLAUDE.md': '#d97706', 'AGENTS.md': '#d97706',
};

// Folder name → color
const FOLDER_COLORS: Record<string, string> = {
  'src': '#42a5f5', 'app': '#ef5350', 'pages': '#ef5350',
  'components': '#ab47bc', 'lib': '#26a69a', 'utils': '#26a69a',
  'hooks': '#7e57c2', 'context': '#e57373',
  'styles': '#ec407a', 'css': '#ec407a',
  'public': '#66bb6a', 'static': '#66bb6a', 'assets': '#ffa726',
  'api': '#42a5f5', 'server': '#42a5f5', 'routes': '#42a5f5',
  'types': '#3178c6', 'interfaces': '#3178c6',
  'config': '#78909c', 'configs': '#78909c', '.vscode': '#007acc',
  'test': '#c21325', 'tests': '#c21325', '__tests__': '#c21325', 'spec': '#c21325',
  'scripts': '#78909c', 'bin': '#78909c', 'cmd': '#78909c',
  'docs': '#42a5f5', 'doc': '#42a5f5',
  'node_modules': '#66bb6a', '.next': '#000000', '.turbo': '#0096ff',
  '.git': '#f05032', '.github': '#6e5494',
  'dist': '#78909c', 'build': '#78909c', 'out': '#78909c', 'target': '#78909c',
  'internal': '#26a69a', 'pkg': '#26a69a',
  'migrations': '#e38c00', 'prisma': '#2d3748',
  'ios': '#a2aaad', 'android': '#3ddc84',
  'src-tauri': '#ffc131',
};

function getFileIconColor(name: string): string {
  // Check exact filename first
  const lower = name.toLowerCase();
  if (FILE_NAME_COLORS[lower]) return FILE_NAME_COLORS[lower];
  if (FILE_NAME_COLORS[name]) return FILE_NAME_COLORS[name];
  // Then extension (handle .d.ts specially)
  if (name.endsWith('.d.ts')) return FILE_ICON_COLORS['.d.ts']!;
  const ext = '.' + name.split('.').pop()?.toLowerCase();
  return FILE_ICON_COLORS[ext] ?? '#89929b';
}

function getFolderColor(name: string): string {
  return FOLDER_COLORS[name.toLowerCase()] ?? '#42a5f5';
}

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
    const iconColor = isChanged ? '#3b82f6' : getFileIconColor(node.name);
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
        <FileText size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: iconColor }} />
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

  const folderColor = getFolderColor(node.name);
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
          ? <FolderOpen size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: hasChangedChild ? '#3b82f6' : folderColor }} />
          : <Folder size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: hasChangedChild ? '#3b82f6' : folderColor }} />
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
  { id: 'files', icon: Folder, label: 'Files' },
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
  onAgentKill,
  lifecycleEvents,
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
  onAgentKill?: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
  lifecycleEvents?: Map<string, { state: string; exitCode?: number; ts: number }>;
} = {}) {
  const [agents, setAgents] = useState<AgentDetail[]>([]);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [commits, setCommits] = useState<{ hash: string; message: string; age: string }[]>([]);
  const [issues, setIssues] = useState<GHIssue[]>([]);
  const [prs, setPrs] = useState<GHPullRequest[]>([]);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<Tab>('files');
  const [activityOpen, setActivityOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
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

  // Ref for triggering immediate fetch from WS events
  const fetchNowRef = useRef<() => void>(() => {});

  // WS listener — triggers immediate re-fetch on agent status changes
  const wsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onInboxUpdate: () => { fetchNowRef.current(); },
    onReviewUpdate: () => { fetchNowRef.current(); setActivityRefreshKey(k => k + 1); },
  }), []);

  const { isConnected: wsConnected } = useDesktopWebSocket(undefined, wsCallbacks);

  // Fetch agent inventory + workspace/PR data in single pass (prevents pop-in/out)
  useEffect(() => {
    async function fetchAll() {
      try {
        // Fetch inventory, workspace enrichments, and registered repos in parallel
        const [invRes, wsRes, repoRes] = await Promise.all([
          fetch(`/api/runtime/inventory?fleetMode=${typeof window !== 'undefined' ? localStorage.getItem('cortex-ide-fleet-mode') ?? 'smart' : 'smart'}`).catch(() => null),
          fetch('/api/panel/workspaces').catch(() => null),
          fetch('/api/panel/repos').catch(() => null),
        ]);

        // Parse inventory
        let newAgents: AgentDetail[] = [];
        if (invRes?.ok) {
          const data = await invRes.json();
          newAgents = data.agents ?? [];
          setEvents(prev => JSON.stringify(prev) === JSON.stringify(data.events ?? []) ? prev : (data.events ?? []));
        }

        // Parse workspace data
        const wsMap = new Map<string, { branch: string; pr: AgentDetail['pr']; localDiff: AgentDetail['localDiff']; workspaceStatus: AgentDetail['workspaceStatus'] }>();
        if (wsRes?.ok) {
          const wsData = await wsRes.json();
          for (const ws of wsData.workspaces ?? []) {
            if (ws.sessionKey) {
              wsMap.set(ws.sessionKey, { branch: ws.branch, pr: ws.pr, localDiff: ws.localDiff, workspaceStatus: ws.status });
            }
          }
        }

        const worktreeMap = new Map<string, WorktreeInfo>();
        if (repoRes?.ok) {
          const repoData = await repoRes.json() as { repos?: Array<{ localPath: string }> };
          const summaries = await Promise.all(
            (repoData.repos ?? []).map(async (repo) => {
              try {
                const res = await fetch(`/api/worktrees?repo=${encodeURIComponent(repo.localPath)}`);
                if (!res.ok) return null;
                return await res.json() as { worktrees?: WorktreeInfo[] };
              } catch {
                return null;
              }
            }),
          );

          for (const summary of summaries) {
            for (const worktree of summary?.worktrees ?? []) {
              if (worktree.sessionKey) {
                worktreeMap.set(worktree.sessionKey, worktree);
              }
            }
          }
        }

        // Merge: always enrich agents with workspace data before setting state
        const enriched = newAgents.map(a => {
          const ws = wsMap.get(a.sessionKey);
          const worktree = worktreeMap.get(a.sessionKey);
          if (!ws && !worktree) return a;
          return {
            ...a,
            branch: ws?.branch ?? a.branch,
            pr: ws?.pr || a.pr,
            localDiff: ws?.localDiff || a.localDiff,
            workspaceStatus: ws?.workspaceStatus ?? a.workspaceStatus,
            worktree: worktree ?? a.worktree,
          };
        });

        if (onAgentsUpdate) onAgentsUpdate(enriched);
        setAgents(prev => JSON.stringify(prev) === JSON.stringify(enriched) ? prev : enriched);
      } catch { /* silent */ }
    }
    // Debounced immediate fetch (WS events may fire rapidly)
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    fetchNowRef.current = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void fetchAll(); }, 300);
    };

    void fetchAll();
    // Safety-net: 60s when WS connected, 30s when disconnected
    const ms = wsConnected ? 60_000 : 30_000;
    const id = setInterval(fetchAll, ms);
    return () => { clearInterval(id); if (debounceTimer) clearTimeout(debounceTimer); };
  }, [wsConnected]);

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

  // Resolve repo → local path for file tree
  const [repoLocalPath, setRepoLocalPath] = useState<string | null>(null);
  useEffect(() => {
    if (!activeRepo) { setRepoLocalPath(null); return; }
    fetch('/api/panel/repos')
      .then(r => r.json())
      .then(data => {
        const match = (data.repos ?? []).find((r: { remoteUrl?: string }) => {
          const url = (r.remoteUrl ?? '').replace(/\.git$/, '');
          return url.endsWith(activeRepo!);
        });
        setRepoLocalPath(match?.localPath ?? null);
      })
      .catch(() => setRepoLocalPath(null));
  }, [activeRepo]);

  // Fetch file tree (re-fetch when repo or workspace changes)
  useEffect(() => {
    async function fetchFiles() {
      try {
        // Priority: workspace > repo local path > default
        const wsPath = activeWorkspace ?? repoLocalPath;
        const wsParam = wsPath ? `?workspace=${encodeURIComponent(wsPath)}` : '';
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
  }, [activeWorkspace, repoLocalPath]);

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

      {/* ── Activity Dropdown (above agents, collapsed by default) ── */}
      <div style={{ flexShrink: 0, paddingLeft: 14, paddingRight: 14, paddingTop: 4, paddingBottom: 0 }}>
        <button
          type="button"
          onClick={() => setActivityOpen(!activityOpen)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 2px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: '-apple-system, system-ui, sans-serif',
          }}
        >
          <Zap size={12} strokeWidth={2} color={activityOpen ? '#ef4444' : 'var(--t-text-muted)'} />
          <span style={{
            fontSize: 11,
            fontWeight: 700,
            color: activityOpen ? 'var(--t-text)' : 'var(--t-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}>
            Activity
          </span>
          <span style={{
            marginLeft: 'auto',
            fontSize: 10,
            color: 'var(--t-text-faint)',
            display: 'flex', alignItems: 'center',
          }}>
            {activityOpen
              ? <ChevronDown size={12} strokeWidth={2} />
              : <ChevronRight size={12} strokeWidth={2} />
            }
          </span>
        </button>
        {activityOpen && (
          <div style={{
            maxHeight: 480,
            overflowY: 'auto',
            borderRadius: 10,
            border: '1px solid var(--t-divider-subtle)',
            background: 'var(--t-panel)',
            marginBottom: 8,
            scrollbarWidth: 'none',
          } as React.CSSProperties}
          className="hide-scrollbar"
          >
            <ActivityFeed
              events={events}
              commits={commits}
              onSelectCommit={onSelectCommit}
              onSelectPR={onSelectPR}
              activeRepo={activeRepo}
              activeAgentKey={expandedGroup ? agents.find(a => a.workspace === expandedGroup)?.sessionKey ?? null : null}
              refreshKey={activityRefreshKey}
            />
          </div>
        )}
      </div>

      {/* ── Agent Cards ── */}
      <div style={{ flexShrink: 0, paddingLeft: 14, paddingRight: 14, paddingTop: 0, paddingBottom: 0 }}>
        <button
          type="button"
          onClick={() => setAgentsOpen(!agentsOpen)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 2px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: '-apple-system, system-ui, sans-serif',
          }}
        >
          <Cpu size={12} strokeWidth={2} color={agentsOpen ? '#ef4444' : 'var(--t-text-muted)'} />
          <span style={{
            fontSize: 11,
            fontWeight: 700,
            color: agentsOpen ? 'var(--t-text)' : 'var(--t-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}>
            Agents
          </span>
          <span style={{
            fontSize: 10,
            color: 'var(--t-text-faint)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}>
            {agents.length}
          </span>
          <span style={{
            marginLeft: 'auto',
            fontSize: 10,
            color: 'var(--t-text-faint)',
            display: 'flex', alignItems: 'center',
          }}>
            {agentsOpen
              ? <ChevronDown size={12} strokeWidth={2} />
              : <ChevronRight size={12} strokeWidth={2} />
            }
          </span>
        </button>
      </div>
      {agentsOpen && (
      <div style={{
        flexShrink: 0,
        paddingTop: 0,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(0,0,0,0.1) transparent',
      } as React.CSSProperties}>
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
              onSelectPR={onSelectPR}
              onAgentKill={onAgentKill}
              lifecycleEvents={lifecycleEvents}
            />
          ))
        )}
      </div>
      )}

      <RepoRegistrySection
        onLaunchComplete={() => { fetchNowRef.current(); }}
        onSelectSession={onSelectSession}
      />

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
      {expandedGroup ? (
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
        borderTop: expandedGroup ? 'none' : '1px solid var(--t-divider-subtle)',
        marginTop: expandedGroup ? 0 : 4,
      }}>
        {activeTab === 'files' ? <FileTree tree={fileTree} changedFiles={changedFiles} onSelectFile={(path) => onSelectFile?.(path, activeWorkspace ?? undefined)} /> : null}
        {activeTab === 'deploy' ? <DeployList onOpenDeploy={onOpenDeploy} /> : null}

      </div>

      {/* ── Issue Detail Modal ── */}
      {selectedIssue !== null ? (
        <IssueModal issueNumber={selectedIssue} onClose={() => setSelectedIssue(null)} />
      ) : null}
      <style>{`
        @keyframes agentCardPulse {
          0%, 100% {
            border-color: rgba(52, 211, 153, 0.25);
            box-shadow: 0 0 12px rgba(52, 211, 153, 0.08), inset 0 0 12px rgba(52, 211, 153, 0.03);
          }
          50% {
            border-color: rgba(52, 211, 153, 0.08);
            box-shadow: 0 0 4px rgba(52, 211, 153, 0.02), inset 0 0 4px rgba(52, 211, 153, 0.01);
          }
        }
      `}</style>
    </div>
  );
});
