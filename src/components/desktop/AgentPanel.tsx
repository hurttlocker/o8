'use client';
/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect, react-hooks/purity -- legacy inspector surface keeps dormant controls and fetch-driven panel state during refactor */

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
import { useSharedDesktopWs } from './hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from './hooks/useDesktopWebSocket';
import { createPortal } from 'react-dom';
import { BlueGlassActionButton, BlueGlassHoverCard, BlueGlassMetricPill, BlueGlassSparklineLane } from './BlueGlassHoverCard';
import {
  ArrowRight,
  AlertCircle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  FileText,
  Folder,
  GitBranch,
  GitCommit,
  ExternalLink,
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
  type LucideIcon,
} from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';
import { RepoRegistrySection } from './RepoRegistrySection';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { WorktreeBadge } from '@/components/mobile/WorktreeBadge';
import { formatModelLabel } from '@/lib/format';
import type { RuntimeSurfaceSummary } from '@/lib/fleet/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import { isTauri } from '@/lib/tauri/bridge';
import { deriveWorkflowStage, describeWorkflowStage, pickDominantWorkflowStage, type WorkflowStageBadge } from '@/lib/workflows/status';

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
  repo?: string;
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
  workflowStage?: WorkflowStageBadge | null;
  tmuxSession?: string;
  runtimeSurface?: RuntimeSurfaceSummary;
  worktree?: WorktreeInfo;
  // Agent lifecycle (from WS)
  lifecycleState?: 'active' | 'completed' | 'failed' | 'killed' | 'stalled';
  exitCode?: number;
  lifecycleTs?: number;
  repoReadiness?: RepoReadiness;
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
  author?: { login?: string | null } | null;
  assignees?: Array<{ login?: string | null }>;
  comments?: number;
  body?: string;
  createdAt?: string;
}

interface GHIssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string; color: string }[];
  author: string;
  assignees?: string[];
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
  reviewDecision?: string;
  statusCheckRollup?: Array<{ name?: string | null; conclusion?: string | null; status?: string | null }>;
}

interface PRHoverDetail {
  mergeable: boolean;
  checksStatus: 'success' | 'failure' | 'pending' | 'unknown';
  reviewDecision: string | null;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
}

interface CIHoverDetail {
  failingJobs: Array<{ name: string; failingStep?: string | null }>;
  summaryLine: string | null;
}

const THEME_ACCENT = 'var(--t-accent, #ef4444)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(239, 68, 68, 0.08))';
const THEME_ACCENT_SOFT_STRONG = 'var(--t-accent-soft-strong, rgba(239, 68, 68, 0.14))';
const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(239, 68, 68, 0.22))';
const THEME_ACCENT_RING = 'var(--t-accent-ring, rgba(239, 68, 68, 0.15))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';

function mergeRiskLabel(detail: PRHoverDetail | null): { label: string; color: string } {
  if (!detail) return { label: 'warming', color: '#64748b' };
  if (!detail.mergeable) return { label: 'conflicts', color: '#dc2626' };
  if (detail.checksStatus === 'failure') return { label: 'ci red', color: '#dc2626' };
  if (detail.checksStatus === 'pending') return { label: 'checks pending', color: '#d97706' };
  if (detail.reviewDecision === 'CHANGES_REQUESTED') return { label: 'changes requested', color: '#dc2626' };
  if (detail.reviewDecision === 'REVIEW_REQUIRED') return { label: 'review pending', color: '#2563eb' };
  return { label: 'merge ready', color: '#16a34a' };
}

// ── Lightweight collection comparisons (replaces JSON.stringify deep compare) ──

/** Compare two arrays by length + a scalar fingerprint per element. */
function arraysMatchBy<T>(a: T[], b: T[], key: (item: T) => string | number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (key(a[i]) !== key(b[i])) return false;
  }
  return true;
}

/** Fingerprint an AgentDetail by its most-volatile scalar fields. */
function agentFp(a: AgentDetail): string {
  return `${a.id}|${a.status}|${a.currentTask}|${a.lastEventAt}|${a.alerts}|${a.branch ?? ''}|${a.workspaceStatus ?? ''}|${a.lifecycleState ?? ''}|${a.runtimeSurface?.reviewContext?.repoSlug ?? ''}|${a.runtimeSurface?.cwd ?? ''}`;
}

/** Fingerprint an EventEntry. */
function eventFp(e: EventEntry): string {
  return `${e.id}|${e.timestamp}`;
}

/** Two Sets are equal if same size and all members match. */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

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

function agentCardSurfaceLabel(agent: AgentDetail, repo: string): string {
  const surface = (agent.surfaceLabel || agent.name || 'Agent').replace(/\s*\(.*\)/, '').trim();
  const firstSurfaceWord = surface.split(/\s+/)[0] || 'Agent';
  const nameLower = (agent.name || '').toLowerCase();
  const modelLower = (agent.model || '').toLowerCase();

  if (nameLower.includes('codex') || modelLower.includes('codex')) return 'Codex';
  if (nameLower.includes('claude')) return 'Claude';
  if (nameLower.includes('telegram')) return 'Telegram';
  if (nameLower.includes('discord')) return 'Discord';
  return firstSurfaceWord;
}

function normalizeAgentTaskSummary(task?: string | null) {
  const raw = task?.trim();
  if (!raw) return '';

  const cleaned = raw
    .replace(/^Live Codex terminal verified via pid\/log mapping(?: on [^.]+)?\.\s*/i, '')
    .replace(/^Live Codex terminal detected(?: on [^.]+)?\.\s*/i, '')
    .replace(/^Recent Codex session recovered from local runtime history\.\s*/i, '')
    .replace(/^Historical Codex session recovered from local runtime history\.\s*/i, '')
    .replace(/^IDE-owned Codex session launched and waiting for its first thread id\.\s*/i, '')
    .replace(/^IDE-owned Codex session is ready for resume after an interrupted run\.\s*/i, '')
    .replace(/^IDE-owned Codex session is ready for a corrective follow-up after a failed run\.\s*/i, '')
    .replace(/^IDE-owned Codex session ready for the next input via resume\.\s*/i, '')
    .replace(/^IDE-owned Codex session is idle\.\s*/i, '')
    .replace(/^Operator marked this owned result resolved\.\s*/i, '')
    .replace(/^Mirroring the live Q ↔ Mister conversation, not spawning a fresh session\.\s*/i, '')
    .trim();

  if (!cleaned) return raw;
  return cleaned.charAt(0).toLowerCase() === cleaned.charAt(0)
    ? `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`
    : cleaned;
}

function agentCardTaskLabel(task?: string | null) {
  const summary = normalizeAgentTaskSummary(task);
  if (!summary) return null;
  const issueMatch = summary.match(/\bIssue #\d+\b/i);
  if (issueMatch) return issueMatch[0].replace(/^issue/i, 'Issue');
  const prMatch = summary.match(/\bPR #\d+\b/i);
  if (prMatch) return prMatch[0].replace(/^pr/i, 'PR');
  if (/review/i.test(summary)) return 'Review';
  return null;
}

function agentCardRepoBranchLine(agent: AgentDetail | null, repoLabel?: string | null) {
  if (!agent) return repoLabel ?? 'Session ready';
  const branch = agent.branch?.trim() && !agent.branch.startsWith('surface/') ? agent.branch.trim() : 'main';
  const repo = repoLabel?.trim()
    || agent.runtimeSurface?.reviewContext?.repoSlug?.split('/').pop()?.trim()
    || agent.workspace?.replace(/^~\//, '').split('/').filter(Boolean).pop()
    || 'workspace';
  return `${repo} · ${branch}`;
}

function agentCardFocusLine(agent: AgentDetail | null, repoLabel: string, fallback: string) {
  const taskLabel = agentCardTaskLabel(agent?.currentTask);
  if (taskLabel) return taskLabel;
  const summary = normalizeAgentTaskSummary(agent?.currentTask);
  if (summary && /^(Issue #\d+|PR #\d+|Review)\b/i.test(summary)) {
    return summary;
  }
  return agentCardRepoBranchLine(agent, repoLabel) || fallback;
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

  // Unknown or empty workspace — group under a generic workspace bucket
  if (!path || path === 'unknown') return 'workspace';

  if (path.includes('/.cortex-worktrees/')) {
    const repoRoot = path.split('/.cortex-worktrees/')[0] ?? '';
    return repoRoot.split('/').pop() || 'workspace';
  }
  if (path.includes('/.claude/worktrees/')) {
    const repoRoot = path.split('/.claude/worktrees/')[0] ?? '';
    return repoRoot.split('/').pop() || 'workspace';
  }

  // Explicit repo path
  if (path.includes('repos/')) {
    const parts = path.split('repos/');
    return parts[1]?.split('/')[0] || path.split('/').pop() || 'workspace';
  }
  if (path.includes('projects/')) {
    const parts = path.split('projects/');
    return parts[1]?.split('/')[0] || path.split('/').pop() || 'workspace';
  }

  // Main workspace
  if (path === 'clawd') return 'workspace';

  return path.split('/').pop() || 'workspace';
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
      'workspace': 'Workspace',
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

function compactWorkspaceLabel(workspace: string | null | undefined) {
  if (!workspace) return null;
  const normalized = workspace.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `~/${parts.slice(-3).join('/')}`;
}

function SidebarSection({
  title,
  icon: Icon,
  count,
  summary,
  accent,
  open,
  onToggle,
  headerAction,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  count?: number | string | null;
  summary?: string | null;
  accent?: string;
  open: boolean;
  onToggle: () => void;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  const tone = accent ?? '#ef4444';

  return (
    <section style={{ borderTop: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, paddingRight: 14 }}>
        <button
          type="button"
          onClick={onToggle}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px 8px',
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text)',
            cursor: 'pointer',
            fontFamily: '-apple-system, system-ui, sans-serif',
          }}
        >
          {Icon ? (
            <span
              style={{
                width: 18,
                height: 18,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: open ? tone : 'var(--t-text-muted)',
                flexShrink: 0,
              }}
            >
              <Icon size={14} strokeWidth={2} />
            </span>
          ) : null}
          <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em' }}>{title}</span>
              {count !== null && count !== undefined ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 18,
                    height: 18,
                    paddingLeft: 6,
                    paddingRight: 6,
                    borderRadius: 999,
                    background: 'var(--t-divider-subtle)',
                    color: 'var(--t-text-secondary)',
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    flexShrink: 0,
                  }}
                >
                  {count}
                </span>
              ) : null}
            </div>
            {summary ? (
              <div
                style={{
                  marginTop: 2,
                  fontSize: 10,
                  lineHeight: 1.35,
                  color: 'var(--t-text-faint)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {summary}
              </div>
            ) : null}
          </div>
        </button>
        {headerAction ? (
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            {headerAction}
          </div>
        ) : null}
      </div>
      {open ? (
        <div style={{ paddingRight: 14, paddingBottom: 10, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

function ActivityDock({
  title,
  count,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number | null;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        flexShrink: 0,
        marginTop: 4,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          color: 'var(--t-text)',
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}
      >
        <ChevronDown
          size={12}
          strokeWidth={2.2}
          color="var(--t-text-muted)"
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 180ms cubic-bezier(0.32, 0.72, 0, 1)',
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--t-text-secondary)' }}>{title}</span>
        {count !== null ? (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--t-text-faint)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}
          >
            {count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          style={{
            padding: '0 14px 10px',
          }}
        >
          <div
            style={{
              maxHeight: 320,
              overflowY: 'auto',
              scrollbarWidth: 'none',
            } as React.CSSProperties}
            className="hide-scrollbar"
          >
            {children}
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ── Agent Card (expandable, workspace-grouped) ──

const AgentCard = memo(function AgentCard({
  group,
  expanded,
  onToggle,
  onSelectSession,
  onSelectPR,
  onReviewPR,
  onAgentKill,
  onRetry,
  lifecycleEvents,
}: {
  group: WorkspaceGroup;
  expanded: boolean;
  onToggle: () => void;
  onSelectSession?: (sessionKey: string) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onAgentKill?: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
  onRetry?: (agent: AgentDetail) => void;
  lifecycleEvents?: Map<string, { state: string; exitCode?: number; ts: number }>;
}) {
  const isCompact = !expanded;
  const model = group.primaryModel;
  const ctx = group.bestContextPct > 0 ? { usedPercent: group.bestContextPct } : null;
  const agentStages = new Map(
    group.agents.map((agent) => [agent.id, agent.workflowStage ?? deriveWorkflowStage({
      runtimeStatus: agent.status,
      workspaceStatus: agent.workspaceStatus,
      lifecycleState: agent.lifecycleState,
      latestText: agent.currentTask,
      readinessState: agent.repoReadiness?.state ?? null,
    })] as const),
  );
  const activeAgents = group.agents.filter((agent) => agentStages.get(agent.id)?.key === 'working');
  const mergeReadyAgents = group.agents.filter((agent) => agentStages.get(agent.id)?.key === 'merge_ready');
  const reviewingAgents = group.agents.filter((agent) => agentStages.get(agent.id)?.key === 'reviewing');
  const waitingAgents = group.agents.filter((agent) => {
    const key = agentStages.get(agent.id)?.key;
    return key === 'waiting' || key === 'queued';
  });
  const blockedAgents = group.agents.filter((agent) => agentStages.get(agent.id)?.key === 'blocked');
  const primaryAgent = activeAgents[0]
    ?? mergeReadyAgents[0]
    ?? reviewingAgents[0]
    ?? waitingAgents[0]
    ?? group.agents.find((agent) => agent.currentTask?.trim())
    ?? group.agents[0]
    ?? null;
  const primaryPr = primaryAgent?.pr ?? group.agents.find((agent) => agent.pr)?.pr ?? null;
  const branchLabel = primaryAgent?.branch && !primaryAgent.branch.startsWith('surface/')
    ? primaryAgent.branch
    : group.agents.find((agent) => agent.branch && !agent.branch.startsWith('surface/'))?.branch ?? null;
  const diffSource = primaryPr
    ? { additions: primaryPr.additions, deletions: primaryPr.deletions, changedFiles: primaryPr.changedFiles }
    : primaryAgent?.localDiff
      ?? group.agents.find((agent) => (
        agent.localDiff && ((agent.localDiff.additions ?? 0) > 0 || (agent.localDiff.deletions ?? 0) > 0)
      ))?.localDiff
      ?? null;
  const focusLine = agentCardFocusLine(
    primaryAgent,
    group.displayName,
    primaryPr?.title
      || branchLabel
      || (activeAgents.length > 0
        ? `${activeAgents.length} active ${activeAgents.length === 1 ? 'agent' : 'agents'} in this workspace`
        : `${group.agents.length} connected ${group.agents.length === 1 ? 'surface' : 'surfaces'}`),
  );
  const chipTone = blockedAgents.length > 0
    ? '#ef4444'
    : mergeReadyAgents.length > 0
      ? '#16a34a'
      : reviewingAgents.length > 0
      ? '#7c3aed'
      : waitingAgents.length > 0
        ? '#b45309'
      : activeAgents.length > 0
        ? '#16a34a'
        : '#64748b';
  const statusLabel = blockedAgents.length > 0
    ? `${blockedAgents.length} blocked`
    : mergeReadyAgents.length > 0
      ? `${mergeReadyAgents.length} merge ready`
      : reviewingAgents.length > 0
      ? `${reviewingAgents.length} in review`
      : waitingAgents.length > 0
        ? `${waitingAgents.length} waiting`
      : activeAgents.length > 0
        ? `${activeAgents.length} active`
        : `${group.agents.length} idle`;
  const metricLabel = ctx ? 'Context' : activeAgents.length > 0 ? 'Active' : 'Agents';
  const metricValue = ctx ? `${ctx.usedPercent}%` : String(activeAgents.length > 0 ? activeAgents.length : group.agents.length);
  const metricTone = ctx ? ctxColor(ctx.usedPercent) : chipTone;
  const surfaceCounts = new Map<string, number>();
  for (const agent of group.agents) {
    const label = agentCardSurfaceLabel(agent, group.repo);
    surfaceCounts.set(label, (surfaceCounts.get(label) ?? 0) + 1);
  }
  const surfaceChips = Array.from(surfaceCounts.entries())
    .map(([label, count]) => count > 1 ? `${label} ×${count}` : label)
    .slice(0, 2);
  const overflowSurfaceCount = Math.max(0, surfaceCounts.size - surfaceChips.length);
  const hasDiffDelta = Boolean(diffSource && (diffSource.additions > 0 || diffSource.deletions > 0));
  const compactSurfaceChip = surfaceChips[0] ?? null;
  const compactMetaKind = primaryPr
    ? 'pr'
    : branchLabel
      ? 'branch'
      : hasDiffDelta
        ? 'diff'
        : compactSurfaceChip
          ? 'surface'
          : group.totalAlerts > 0
            ? 'alert'
            : null;
  const cardBackground = expanded
    ? 'linear-gradient(180deg, var(--t-panel) 0%, var(--t-panel-translucent) 100%)'
    : group.hasRunning
      ? 'linear-gradient(180deg, var(--t-panel-translucent) 0%, var(--t-bg-card, rgba(148, 163, 184, 0.08)) 100%)'
      : 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
  const cardBorder = expanded
    ? `1px solid ${THEME_ACCENT_BORDER}`
    : '1px solid var(--t-panel-border)';
  const iconTint = group.hasRunning ? THEME_ACCENT_SOFT : 'var(--t-divider-subtle)';
  const headerPadding = expanded ? '13px 14px 12px' : '10px 11px 9px';
  const iconBoxSize = expanded ? 36 : 30;
  const iconRadius = expanded ? 12 : 10;
  const iconSize = expanded ? 16 : 14;
  const contentGap = expanded ? 8 : 5;
  const titleSize = expanded ? 13 : 12;
  const modelBadgeFontSize = expanded ? 10 : 9;
  const modelBadgePadding = expanded ? '3px 8px' : '2px 6px';
  const summaryFontSize = expanded ? 12 : 11;
  const summaryLineHeight = expanded ? '16px' : '14px';
  const summaryClamp = expanded ? 2 : 1;
  const chipGap = expanded ? 6 : 5;
  const chipPadding = expanded ? '4px 8px' : '3px 7px';
  const chipFontSize = expanded ? 10 : 9;
  const metricMinWidth = expanded ? 58 : 48;
  const metricPadding = expanded ? '6px 8px 7px' : '5px 7px 6px';
  const metricValueFontSize = expanded ? 15 : 13;

  return (
    <div style={{
      background: expanded ? 'rgba(255,255,255,0.025)' : 'transparent',
      borderBottom: '1px solid var(--t-divider-subtle)',
      transition: 'all 200ms ease',
      overflow: 'hidden',
    }}>
      {/* Card header — repo-grouped */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: isCompact ? 10 : 12,
          padding: expanded ? '12px 0 10px' : '10px 0 9px',
          cursor: 'pointer',
        }}
      >
        <div style={{
          width: expanded ? 20 : 18,
          height: expanded ? 20 : 18,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: group.repo === 'workspace' ? THEME_ACCENT : 'var(--t-text-secondary)',
          flexShrink: 0,
          marginTop: 2,
        }}>
          {group.repo === 'workspace' ? (
            <Monitor size={expanded ? 14 : 13} strokeWidth={2} />
          ) : (
            <svg width={expanded ? 14 : 13} height={expanded ? 14 : 13} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block' }}>
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
            </svg>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: contentGap }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: isCompact ? 6 : 8, minWidth: 0 }}>
            <span style={{
              fontSize: titleSize,
              fontWeight: 700,
              color: 'var(--t-text-strong)',
              letterSpacing: '-0.01em',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>{group.displayName}</span>
            {model && formatModelLabel(model) && (
              <span style={{
                fontSize: modelBadgeFontSize,
                fontWeight: 700,
                color: 'var(--t-text-secondary)',
                padding: modelBadgePadding,
                borderRadius: 999,
                background: 'var(--t-divider-subtle)',
                border: '1px solid var(--t-divider)',
                maxWidth: isCompact ? 104 : 140,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}>
                {formatModelLabel(model)}
              </span>
            )}
          </div>
          <div style={{
            fontSize: summaryFontSize,
            lineHeight: summaryLineHeight,
            color: 'var(--t-text-secondary)',
            fontWeight: 520,
            letterSpacing: '-0.01em',
            display: '-webkit-box',
            WebkitLineClamp: summaryClamp,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            {focusLine}
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: chipGap,
            flexWrap: isCompact ? 'nowrap' : 'wrap',
            overflow: 'hidden',
            minWidth: 0,
          }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: chipPadding,
              borderRadius: 999,
              background: `${chipTone}12`,
              color: chipTone,
              border: `1px solid ${chipTone}20`,
              fontSize: chipFontSize,
              fontWeight: 700,
              letterSpacing: '0.01em',
              flexShrink: 0,
            }}>
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: chipTone,
                boxShadow: activeAgents.length > 0 ? `0 0 10px ${chipTone}66` : 'none',
              }} />
              {statusLabel}
            </span>
            {expanded && primaryPr ? (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  (onReviewPR ?? onSelectPR)?.(primaryPr.number, group.repo);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: chipPadding,
                  borderRadius: 999,
                  background: THEME_ACCENT_SOFT,
                  color: THEME_ACCENT,
                  border: `1px solid ${THEME_ACCENT_BORDER}`,
                  fontSize: chipFontSize,
                  fontWeight: 700,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                PR #{primaryPr.number}
              </span>
            ) : expanded && branchLabel ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                maxWidth: 112,
                padding: chipPadding,
                borderRadius: 999,
                background: THEME_BG_CARD,
                border: '1px solid var(--t-panel-border)',
                color: 'var(--t-text-secondary)',
                fontSize: chipFontSize,
                fontWeight: 700,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}>
                {branchLabel}
              </span>
            ) : null}
            {expanded && hasDiffDelta ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: chipPadding,
                borderRadius: 999,
                background: THEME_BG_CARD,
                border: '1px solid var(--t-panel-border)',
                color: 'var(--t-text-secondary)',
                fontSize: chipFontSize,
                fontWeight: 700,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                flexShrink: 0,
              }}>
                <span style={{ color: '#16a34a' }}>+{diffSource?.additions.toLocaleString()}</span>
                <span style={{ color: '#ef4444' }}>-{diffSource?.deletions.toLocaleString()}</span>
              </span>
            ) : null}
            {expanded ? surfaceChips.map((label) => (
              <span
                key={label}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: chipPadding,
                  borderRadius: 999,
                  background: THEME_BG_CARD,
                  border: '1px solid var(--t-panel-border)',
                  color: 'var(--t-text-secondary)',
                  fontSize: chipFontSize,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {label}
              </span>
            )) : compactMetaKind === 'pr' && primaryPr ? (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  (onReviewPR ?? onSelectPR)?.(primaryPr.number, group.repo);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: chipPadding,
                  borderRadius: 999,
                  background: THEME_ACCENT_SOFT,
                  color: THEME_ACCENT,
                  border: `1px solid ${THEME_ACCENT_BORDER}`,
                  fontSize: chipFontSize,
                  fontWeight: 700,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                PR #{primaryPr.number}
              </span>
            ) : compactMetaKind === 'branch' && branchLabel ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                maxWidth: 92,
                padding: chipPadding,
                borderRadius: 999,
                background: THEME_BG_CARD,
                border: '1px solid var(--t-panel-border)',
                color: 'var(--t-text-secondary)',
                fontSize: chipFontSize,
                fontWeight: 700,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}>
                {branchLabel}
              </span>
            ) : compactMetaKind === 'diff' && hasDiffDelta ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                padding: chipPadding,
                borderRadius: 999,
                background: THEME_BG_CARD,
                border: '1px solid var(--t-panel-border)',
                color: 'var(--t-text-secondary)',
                fontSize: chipFontSize,
                fontWeight: 700,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                flexShrink: 0,
              }}>
                <span style={{ color: '#16a34a' }}>+{diffSource?.additions.toLocaleString()}</span>
                <span style={{ color: '#ef4444' }}>-{diffSource?.deletions.toLocaleString()}</span>
              </span>
            ) : compactMetaKind === 'surface' && compactSurfaceChip ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: chipPadding,
                borderRadius: 999,
                background: THEME_BG_CARD,
                border: '1px solid var(--t-panel-border)',
                color: 'var(--t-text-secondary)',
                fontSize: chipFontSize,
                fontWeight: 700,
                flexShrink: 0,
              }}>
                {compactSurfaceChip}
              </span>
            ) : compactMetaKind === 'alert' && group.totalAlerts > 0 ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: chipPadding,
                borderRadius: 999,
                background: 'rgba(239, 68, 68, 0.08)',
                color: '#dc2626',
                fontSize: chipFontSize,
                fontWeight: 700,
                flexShrink: 0,
              }}>
                <AlertCircle size={10} strokeWidth={2} />
                {group.totalAlerts}
              </span>
            ) : null}
            {expanded && overflowSurfaceCount > 0 ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: chipPadding,
                borderRadius: 999,
                background: THEME_BG_CARD,
                border: '1px solid var(--t-panel-border)',
                color: 'var(--t-text-secondary)',
                fontSize: chipFontSize,
                fontWeight: 700,
                flexShrink: 0,
              }}>
                +{overflowSurfaceCount}
              </span>
            ) : null}
            {expanded && group.totalAlerts > 0 && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: chipPadding,
                borderRadius: 999,
                background: 'rgba(239, 68, 68, 0.08)',
                color: '#dc2626',
                fontSize: chipFontSize,
                fontWeight: 700,
                flexShrink: 0,
              }}>
                <AlertCircle size={11} strokeWidth={2} />
                {group.totalAlerts}
              </span>
            )}
          </div>
        </div>

        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: isCompact ? 8 : 10,
          flexShrink: 0,
        }}>
          <div style={{
            minWidth: metricMinWidth,
            padding: metricPadding,
            borderRadius: 999,
            background: ctx ? `${metricTone}12` : 'var(--t-divider-subtle)',
            border: `1px solid ${ctx ? `${metricTone}24` : 'var(--t-panel-border)'}`,
            textAlign: 'right',
          }}>
            <div style={{
              fontSize: isCompact ? 7 : 8,
              fontWeight: 700,
              color: 'var(--t-text-faint)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: isCompact ? 2 : 3,
            }}>
              {metricLabel}
            </div>
            <div style={{
              fontSize: metricValueFontSize,
              lineHeight: 1,
              fontWeight: 800,
              color: metricTone,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              letterSpacing: '-0.03em',
            }}>
              {metricValue}
            </div>
          </div>
          {expanded
            ? <ChevronDown size={14} strokeWidth={2} style={{ color: 'var(--t-text-muted)' }} />
            : <ChevronRight size={14} strokeWidth={2} style={{ color: 'var(--t-text-faint)' }} />
          }
        </div>
      </div>

      {/* Expanded: status-grouped agent cards */}
      {expanded && (() => {
        type AgentStatus = 'in_progress' | 'waiting' | 'in_review' | 'merge_ready' | 'stalled' | 'completed' | 'failed' | 'idle';
        const classify = (a: AgentDetail): AgentStatus => {
          const stage = agentStages.get(a.id);
          if (stage?.key === 'blocked') {
            if (a.lifecycleState === 'stalled') return 'stalled';
            return 'failed';
          }
          if (stage?.key === 'merge_ready') return 'merge_ready';
          if (stage?.key === 'reviewing') return 'in_review';
          if (stage?.key === 'waiting' || stage?.key === 'queued') return 'waiting';
          if (stage?.key === 'ready') return 'completed';
          if (stage?.key === 'working') return 'in_progress';
          return 'idle';
        };
        const statusGroups: { key: AgentStatus; label: string; color: string; agents: AgentDetail[] }[] = [
          { key: 'in_progress', label: 'In Progress', color: '#2563eb', agents: [] },
          { key: 'waiting', label: 'Waiting', color: '#b45309', agents: [] },
          { key: 'in_review', label: 'In Review', color: '#f59e0b', agents: [] },
          { key: 'merge_ready', label: 'Merge Ready', color: '#16a34a', agents: [] },
          { key: 'stalled', label: 'Stalled', color: '#f97316', agents: [] },
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
          const stage = agentStages.get(agent.id);
          const isRunning = stage?.key === 'working';
          const isFailed = stage?.key === 'blocked' && lcState !== 'stalled';
          const isCompleted = stage?.key === 'ready';
          const isStalled = lcState === 'stalled';
          const isMergeReady = stage?.key === 'merge_ready';
          const isReviewing = stage?.key === 'reviewing';
          const isWaiting = stage?.key === 'waiting' || stage?.key === 'queued';
          const agentDot = isFailed ? '#ef4444' : isStalled ? '#f97316' : isMergeReady ? '#16a34a' : isCompleted ? '#22c55e' : isRunning ? '#22c55e' : isReviewing ? '#a78bfa' : isWaiting ? '#b45309' : '#9ca3af';

          // Agent display info
          const nameLower = (agent.name || '').toLowerCase();
          const modelLower = (agent.model || '').toLowerCase();
          const isCodex = nameLower.includes('codex') || modelLower.includes('codex');
          const isClaudeCode = nameLower.includes('claude code') || nameLower.includes('claude-code');
          const fullName = isCodex ? 'Codex'
            : isClaudeCode ? 'Claude Code'
            : (agent.surfaceLabel || agent.name);

          // Task description — latest commit, current task, or branch
          const taskDesc = agent.currentTask || null;
          const branch = agent.branch || null;
          const pr = agent.pr;
          const diff = pr ? { add: pr.additions, del: pr.deletions } : agent.localDiff ? { add: agent.localDiff.additions, del: agent.localDiff.deletions } : null;
          const statusLabel = stage?.label ?? (isStalled ? 'Blocked' : null);

          return (
            <div
              key={agent.id}
              onClick={(e) => {
                e.stopPropagation();
                if (agent.sessionKey && onSelectSession) onSelectSession(agent.sessionKey);
              }}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '8px 10px',
                borderRadius: 8,
                background: isRunning || isMergeReady ? 'rgba(34,197,94,0.08)' : isReviewing ? 'rgba(167,139,250,0.08)' : isWaiting ? 'rgba(245,158,11,0.08)' : 'transparent',
                border: isRunning || isMergeReady ? '1px solid rgba(34,197,94,0.18)' : isReviewing ? '1px solid rgba(167,139,250,0.18)' : isWaiting ? '1px solid rgba(245,158,11,0.18)' : '1px solid transparent',
                cursor: agent.sessionKey ? 'pointer' : 'default',
                transition: 'all 150ms ease',
                animation: isRunning ? 'agentCardPulse 3s ease-in-out infinite' : 'none',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = isRunning || isMergeReady ? 'rgba(34,197,94,0.12)' : isReviewing ? 'rgba(167,139,250,0.12)' : isWaiting ? 'rgba(245,158,11,0.12)' : 'var(--t-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isRunning || isMergeReady ? 'rgba(34,197,94,0.08)' : isReviewing ? 'rgba(167,139,250,0.08)' : isWaiting ? 'rgba(245,158,11,0.08)' : 'transparent';
              }}
            >
              {/* Status dot with glow / reviewing pulse */}
              <span style={{
                position: 'relative',
                width: 7, height: 7,
                flexShrink: 0,
                marginTop: 5,
              }}>
                {isReviewing && (
                  <span style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: '50%',
                    background: '#a78bfa',
                    animation: 'reviewingRing 2s cubic-bezier(0.4, 0, 0.2, 1) infinite',
                  }} />
                )}
                <span style={{
                  position: 'relative',
                  display: 'block',
                  width: 7, height: 7, borderRadius: '50%',
                  background: isReviewing ? 'linear-gradient(135deg, #f59e0b, #a78bfa)' : agentDot,
                  boxShadow: isRunning || isMergeReady ? `0 0 8px ${agentDot}` : isReviewing ? '0 0 8px rgba(167, 139, 250, 0.5)' : 'none',
                  animation: isReviewing ? 'reviewingBreathe 2.4s ease-in-out infinite' : 'none',
                }} />
              </span>

              {/* Main content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Line 1: Agent name (bold) + status */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  lineHeight: '16px',
                }}>
                  <span style={{
                    fontSize: 12, fontWeight: 700,
                    color: 'var(--t-text)',
                    letterSpacing: '-0.01em',
                  }}>
                    {fullName}
                  </span>
                  {statusLabel && (
                    <span style={{
                      fontSize: 10, fontWeight: 600,
                      color: isRunning || isMergeReady ? '#16a34a' : isReviewing ? '#a78bfa' : isStalled ? '#f97316' : isFailed ? '#ef4444' : '#22c55e',
                    }}>
                      {statusLabel}
                    </span>
                  )}
                </div>

                {/* Line 2: branch · PR # · model */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  marginTop: 1,
                  fontSize: 10, color: 'var(--t-text-muted)',
                }}>
                  {branch && !branch.startsWith('surface/') && (
                    <span style={{
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                      maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {branch}
                    </span>
                  )}
                  {pr && (
                    <>
                      {branch && <span style={{ color: 'var(--t-text-faint)' }}>·</span>}
                      <span
                        onClick={(e) => { e.stopPropagation(); (onReviewPR ?? onSelectPR)?.(pr.number, group.repo); }}
                        style={{
                          fontWeight: 600,
                          color: pr.state === 'merged' ? '#8b5cf6' : pr.state === 'open' ? '#22c55e' : '#9ca3af',
                          cursor: 'pointer',
                        }}
                      >
                        PR #{pr.number}
                      </span>
                    </>
                  )}
                  {formatModelLabel(agent.model || '') && (
                    <>
                      {(branch || pr) && <span style={{ color: 'var(--t-text-faint)' }}>·</span>}
                      <span style={{ fontWeight: 500 }}>
                        {formatModelLabel(agent.model || '')}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Right: diff stats or failed-state actions */}
              {isFailed ? (
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginTop: 1 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRetry?.(agent);
                    }}
                    style={{
                      padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.2)',
                      background: 'rgba(239,68,68,0.06)', color: '#ef4444',
                      fontSize: 10, fontWeight: 600, cursor: 'pointer',
                      fontFamily: 'inherit', lineHeight: '14px',
                    }}
                  >
                    Retry
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      // Dismiss: kill agent so it re-appears as idle on next fetch
                      if (agent.tmuxSession) onAgentKill?.(agent.tmuxSession, 'SIGTERM');
                    }}
                    style={{
                      padding: '4px 10px', borderRadius: 6, border: '1px solid var(--t-panel-border)',
                      background: THEME_BG_CARD, color: 'var(--t-text-muted)',
                      fontSize: 10, fontWeight: 600, cursor: 'pointer',
                      fontFamily: 'inherit', lineHeight: '14px',
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              ) : diff && (diff.add > 0 || diff.del > 0) ? (
                <span
                  onClick={pr ? (e) => { e.stopPropagation(); (onReviewPR ?? onSelectPR)?.(pr.number, group.repo); } : undefined}
                  style={{
                    fontSize: 10, fontWeight: 700,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    display: 'flex', gap: 3, flexShrink: 0,
                    cursor: pr ? 'pointer' : 'default',
                    padding: '2px 6px',
                    borderRadius: 5,
                    background: THEME_BG_CARD,
                    border: '1px solid var(--t-panel-border)',
                    marginTop: 1,
                  }}
                >
                  <span style={{ color: '#22c55e' }}>+{diff.add.toLocaleString()}</span>
                  <span style={{ color: '#ef4444' }}>-{diff.del.toLocaleString()}</span>
                </span>
              ) : null}
            </div>
          );
        };

        return (
          <div style={{
            borderTop: '1px solid var(--t-divider-subtle)',
            padding: '6px 0 10px 26px',
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
  | { kind: 'commit'; hash: string; message: string; age: string; ts: number; repo?: string }
  | { kind: 'event'; data: EventEntry; ts: number }
  | { kind: 'issue'; number: number; title: string; state: string; labels: { name: string; color: string }[]; age: string; ts: number; repo: string; author: string; assignees: string[]; comments: number; body: string }
  | { kind: 'pr'; number: number; title: string; state: string; author: string; branch: string; additions: number; deletions: number; changedFiles: number; age: string; ts: number; repo: string; reviewDecision?: string; checkSummary?: { passed: number; failed: number; pending: number }; failingChecks?: string[] }
  | { kind: 'ci'; id: number; title: string; status: string; conclusion: string; branch: string; workflow: string; age: string; ts: number; repo: string };

type RepoTaskLaunchRequest =
  | { kind: 'issue'; repo: string; number: number; title: string; body?: string }
  | { kind: 'pr'; repo: string; number: number; title: string; branch?: string };

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

// Special "all repos" key
const ALL_REPOS_KEY = '__github__';

function normalizeRepoSlug(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^[\w.-]+\/[\w.-]+$/.test(trimmed) ? trimmed : null;
}

function repoSlugFromRemoteUrl(remoteUrl?: string | null) {
  const normalized = remoteUrl
    ?.replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized?.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

function shortRepoLabel(repo?: string | null) {
  if (!repo) return 'Local activity';
  return repo.split('/').pop() ?? repo;
}

function shortWorkspaceLabel(workspace?: string | null) {
  const trimmed = workspace?.trim();
  if (!trimmed || trimmed === 'unknown') return 'Local activity';

  const parts = trimmed.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return parts[0] ?? 'Local activity';
}

function compactActivitySummaryLabel(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return 'Recent workflow events';
  const segments = trimmed
    .split(/[·•]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length <= 1) return trimmed;
  const seen = new Set<string>();
  const deduped = segments.filter((segment) => {
    const key = segment.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.join(' · ');
}

function agentRepoSlug(agent?: AgentDetail | null) {
  return normalizeRepoSlug(agent?.runtimeSurface?.reviewContext?.repoSlug);
}

function activityItemKey(item: ActivityItem) {
  if (item.kind === 'commit') return `c-${item.repo ?? 'local'}-${item.hash}`;
  if (item.kind === 'event') return `e-${item.data.id}`;
  if (item.kind === 'issue') return `i-${item.repo}-${item.number}`;
  if (item.kind === 'pr') return `pr-${item.repo}-${item.number}`;
  return `ci-${item.repo}-${item.id}`;
}

function normalizeActivitySubject(value?: string | null) {
  if (!value) return null;
  return value
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const ActivityFeed = memo(function ActivityFeed({
  events,
  commits,
  agents,
  onSelectSession,
  onSelectIssue,
  onSelectCommit,
  onSelectPR,
  onReviewPR,
  onLaunchTask,
  activeRepo: externalRepo,
  activeAgentKey,
  refreshKey,
}: {
  events: EventEntry[];
  commits: { hash: string; message: string; age: string }[];
  agents: AgentDetail[];
  onSelectSession?: (sessionKey: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onLaunchTask?: (request: RepoTaskLaunchRequest) => void;
  activeRepo?: string | null;
  activeAgentKey?: string | null;
  refreshKey?: number;
}) {
  const [extras, setExtras] = useState<{ issues: ActivityItem[]; prs: ActivityItem[]; ciRuns: ActivityItem[]; repoCommits: ActivityItem[] }>({ issues: [], prs: [], ciRuns: [], repoCommits: [] });
  const [remoteScopeError, setRemoteScopeError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [repoOverride, setRepoOverride] = useState<string | null>(null);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [registeredRepos, setRegisteredRepos] = useState<string[]>([]);
  const [hoveredItemKey, setHoveredItemKey] = useState<string | null>(null);
  const [hoveredItemRect, setHoveredItemRect] = useState<DOMRect | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [prHoverDetails, setPrHoverDetails] = useState<Record<string, PRHoverDetail>>({});
  const [ciHoverDetails, setCiHoverDetails] = useState<Record<string, CIHoverDetail>>({});

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

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.sessionKey === activeAgentKey) ?? null,
    [agents, activeAgentKey],
  );
  const activeAgentRepo = useMemo(() => agentRepoSlug(activeAgent), [activeAgent]);
  const activeAgentWorkspaceLabel = useMemo(
    () => shortWorkspaceLabel(activeAgent?.runtimeSurface?.cwd ?? activeAgent?.workspace),
    [activeAgent],
  );
  const externalPanelRepo = useMemo(() => normalizeRepoSlug(externalRepo), [externalRepo]);
  const liveAgentRepos = useMemo(
    () => agents
      .map((agent) => agentRepoSlug(agent))
      .filter((repo): repo is string => Boolean(repo)),
    [agents],
  );

  // Merge live repo truth with registered GitHub repos (deduped, stable order)
  const allRepos = useMemo(() => {
    const set = new Set<string>();
    if (activeAgentRepo) set.add(activeAgentRepo);
    if (externalPanelRepo) set.add(externalPanelRepo);
    for (const repo of liveAgentRepos) set.add(repo);
    for (const repo of registeredRepos) {
      const normalized = normalizeRepoSlug(repo);
      if (normalized) set.add(normalized);
    }
    return Array.from(set);
  }, [activeAgentRepo, externalPanelRepo, liveAgentRepos, registeredRepos]);

  // Resolve Activity scope: manual override > live agent repo > expanded workspace repo > GitHub aggregate
  const repo = useMemo(() => {
    if (repoOverride) return repoOverride;
    if (externalPanelRepo) return externalPanelRepo;
    if (activeAgentRepo) return activeAgentRepo;
    if (allRepos.length > 0) return ALL_REPOS_KEY;
    return null;
  }, [repoOverride, activeAgentRepo, externalPanelRepo, allRepos]);

  const isAllRepos = repo === ALL_REPOS_KEY;
  const repoLabel = isAllRepos ? 'GitHub' : repo ? shortRepoLabel(repo) : activeAgentWorkspaceLabel;
  const scopeHelp = isAllRepos
    ? 'Recent pull requests, commits, issues, and checks across your registered repos.'
    : repo
      ? `Recent pull requests, commits, issues, and checks for ${shortRepoLabel(repo)}.`
      : 'Recent repo work appears here once a GitHub repo is attached.';

  // Clear override when agent changes
  useEffect(() => { setRepoOverride(null); }, [activeAgentKey]);

  const agentRepoById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agentRepoSlug(agent)])),
    [agents],
  );

  const visibleAgentEvents = useMemo(() => {
    return events.filter((event) => {
      const eventRepo = agentRepoById.get(event.agentId) ?? null;
      if (!eventRepo) return false;
      if (!repo || isAllRepos) return true;
      return eventRepo === repo;
    });
  }, [agentRepoById, events, isAllRepos, repo]);

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
      const errors: string[] = [];
      const issueItems: ActivityItem[] = [];
      if (issuesRes?.ok) {
        const data = await issuesRes.json();
        if (data.error) errors.push(String(data.error));
        for (const i of (data.issues ?? []).slice(0, 8)) {
          const ts = i.createdAt ? new Date(i.createdAt).getTime() : 0;
          issueItems.push({
            kind: 'issue',
            number: i.number,
            title: i.title,
            state: (i.state ?? '').toLowerCase(),
            labels: i.labels ?? [],
            age: i.createdAt ? relativeAge(i.createdAt) : '',
            ts,
            repo: r,
            author: i.author?.login ?? 'unknown',
            assignees: (i.assignees ?? [])
              .map((assignee: { login?: string | null }) => assignee.login ?? '')
              .filter(Boolean),
            comments: typeof i.comments === 'number' ? i.comments : 0,
            body: (i.body ?? '').trim(),
          });
        }
      }

      const prItems: ActivityItem[] = [];
      if (prsRes?.ok) {
        const data = await prsRes.json();
        if (data.error) errors.push(String(data.error));
        for (const p of (data.prs ?? []).slice(0, 8)) {
          const ts = p.createdAt ? new Date(p.createdAt).getTime() : 0;
          const checks = p.statusCheckRollup ?? [];
          prItems.push({
            kind: 'pr',
            number: p.number,
            title: p.title,
            state: (p.state ?? '').toLowerCase(),
            author: p.author?.login ?? '',
            branch: p.headRefName ?? '',
            additions: p.additions ?? 0,
            deletions: p.deletions ?? 0,
            changedFiles: p.changedFiles ?? 0,
            reviewDecision: p.reviewDecision ?? '',
            checkSummary: {
              passed: checks.filter((check: { conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'success').length,
              failed: checks.filter((check: { conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'failure').length,
              pending: checks.filter((check: { conclusion?: string | null; status?: string | null }) => !check.conclusion || check.status?.toLowerCase() !== 'completed').length,
            },
            failingChecks: checks
              .filter((check: { name?: string | null; conclusion?: string | null }) => check.conclusion?.toLowerCase() === 'failure')
              .map((check: { name?: string | null }) => check.name || 'Unknown check')
              .slice(0, 3),
            age: p.createdAt ? relativeAge(p.createdAt) : '',
            ts,
            repo: r,
          });
        }
      }

      const ciItems: ActivityItem[] = [];
      if (ciRes?.ok) {
        const data = await ciRes.json();
        if (data.error) errors.push(String(data.error));
        for (const c of (data.runs ?? []).slice(0, 6)) {
          const ts = c.createdAt ? new Date(c.createdAt).getTime() : 0;
          ciItems.push({ kind: 'ci', id: c.databaseId, title: c.displayTitle ?? '', status: c.status ?? '', conclusion: c.conclusion ?? '', branch: c.headBranch ?? '', workflow: c.workflowName ?? '', age: c.createdAt ? relativeAge(c.createdAt) : '', ts, repo: r });
        }
      }

      const commitItems: ActivityItem[] = [];
      if (commitsRes?.ok) {
        const data = await commitsRes.json();
        if (data.error) errors.push(String(data.error));
        for (const c of (data.commits ?? []).slice(0, 10)) {
          const ts = c.date ? new Date(c.date).getTime() : 0;
          commitItems.push({ kind: 'commit', hash: c.hash ?? '', message: `${isAllRepos ? `[${repoSlug}] ` : ''}${c.message ?? ''}`, age: c.date ? relativeAge(c.date) : '', ts, repo: r });
        }
      }

      return { issues: issueItems, prs: prItems, ciRuns: ciItems, commits: commitItems, errors };
    }

    async function fetchExtras() {
      try {
        if (!repo) {
          setExtras({ issues: [], prs: [], ciRuns: [], repoCommits: [] });
          setRemoteScopeError(null);
          return;
        }

        if (isAllRepos) {
          // Fetch from all known repos in parallel
          const repos = allRepos;
          if (repos.length === 0) {
            setExtras({ issues: [], prs: [], ciRuns: [], repoCommits: [] });
            setRemoteScopeError(null);
            return;
          }
          const results = await Promise.all(repos.map(r => fetchForRepo(r).catch((error) => ({
            issues: [],
            prs: [],
            ciRuns: [],
            commits: [],
            errors: [error instanceof Error ? error.message : 'Unable to load repo activity'],
          }))));
          const merged = { issues: [] as ActivityItem[], prs: [] as ActivityItem[], ciRuns: [] as ActivityItem[], repoCommits: [] as ActivityItem[] };
          const mergedErrors: string[] = [];
          for (const r of results) {
            merged.issues.push(...r.issues);
            merged.prs.push(...r.prs);
            merged.ciRuns.push(...r.ciRuns);
            merged.repoCommits.push(...r.commits);
            mergedErrors.push(...r.errors);
          }
          setExtras(merged);
          setRemoteScopeError(mergedErrors.length > 0 ? Array.from(new Set(mergedErrors)).join(' | ') : null);
        } else {
          const result = await fetchForRepo(repo);
          setExtras({ issues: result.issues, prs: result.prs, ciRuns: result.ciRuns, repoCommits: result.commits });
          setRemoteScopeError(result.errors.length > 0 ? result.errors.join(' | ') : null);
        }
      } catch { /* silent */ }
    }
    fetchExtras();
    const id = setInterval(fetchExtras, 60_000);
    return () => clearInterval(id);
  }, [repo, isAllRepos, allRepos, refreshKey]);

  // Build unified timeline — commits now come from per-repo fetch, not parent prop
  const fallbackCommitItems = useMemo<ActivityItem[]>(() => {
    // Never leak local review commits into GitHub-scoped views.
    if (repo || extras.repoCommits.length > 0) return [];
    const fallbackRepo = externalPanelRepo ?? activeAgentRepo ?? null;
    return commits.slice(0, 10).map((commit, index) => ({
      kind: 'commit' as const,
      hash: commit.hash,
      message: commit.message,
      age: commit.age,
      ts: Date.now() - index,
      repo: fallbackRepo ?? undefined,
    }));
  }, [activeAgentRepo, commits, externalPanelRepo, extras.repoCommits.length, repo]);

  const items = useMemo<ActivityItem[]>(() => {
    const all: ActivityItem[] = [];

    // Repo-specific commits from API
    all.push(...extras.repoCommits, ...fallbackCommitItems);

    // Keep live/local agent chatter only for the aggregate feed.
    if (!repo || isAllRepos) {
      for (const e of visibleAgentEvents) {
        const ts = e.timestamp ? new Date(e.timestamp).getTime() || Date.now() : Date.now();
        all.push({ kind: 'event', data: e, ts });
      }
    }

    all.push(...extras.issues, ...extras.prs, ...extras.ciRuns);

    // Sort newest first
    all.sort((a, b) => b.ts - a.ts);
    return all.slice(0, 40);
  }, [extras, fallbackCommitItems, isAllRepos, repo, visibleAgentEvents]);

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
    if (filter === 'all') {
      const primarySubjects = new Set(
        items.flatMap((item) => {
          if (item.kind === 'commit') {
            const subject = normalizeActivitySubject(item.message);
            return subject ? [subject] : [];
          }
          if (item.kind === 'pr') {
            const subject = normalizeActivitySubject(item.title);
            return subject ? [subject] : [];
          }
          return [];
        }),
      );
      return items.filter((item) => {
        if (item.kind === 'ci') {
          const subject = normalizeActivitySubject(item.title);
          if (subject && primarySubjects.has(subject)) return false;
        }
        return true;
      });
    }
    return items.filter(i => i.kind === filter);
  }, [items, filter]);

  const commitStack = useMemo(
    () => extras.repoCommits.filter((item): item is Extract<ActivityItem, { kind: 'commit' }> => item.kind === 'commit').slice(0, 5),
    [extras.repoCommits],
  );

  const openHoverCard = useCallback((key: string, rect: DOMRect) => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    setHoveredItemKey(key);
    setHoveredItemRect(rect);
  }, []);

  const scheduleHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = setTimeout(() => {
      setHoveredItemKey(null);
      setHoveredItemRect(null);
    }, 140);
  }, []);

  useEffect(() => {
    if (!hoveredItemKey) return;
    const hoveredItem = items.find((item) => activityItemKey(item) === hoveredItemKey);
    if (!hoveredItem) return;

    if (hoveredItem.kind === 'pr' && !prHoverDetails[hoveredItemKey]) {
      fetch(`/api/panel/pr?repo=${encodeURIComponent(hoveredItem.repo)}&number=${hoveredItem.number}`)
        .then((response) => response.json())
        .then((detail) => {
          if (detail?.error) return;
          setPrHoverDetails((current) => ({
            ...current,
            [hoveredItemKey]: {
              mergeable: Boolean(detail.mergeable),
              checksStatus: detail.checksStatus ?? 'unknown',
              reviewDecision: detail.reviewDecision ?? null,
              files: detail.files ?? [],
            },
          }));
        })
        .catch(() => {});
    }

    if (hoveredItem.kind === 'ci' && !ciHoverDetails[hoveredItemKey]) {
      fetch(`/api/panel/ci/${hoveredItem.id}?repo=${encodeURIComponent(hoveredItem.repo)}`)
        .then((response) => response.json())
        .then((detail) => {
          if (detail?.error) return;
          const jobs = detail.run?.jobs ?? [];
          const failingJobs = jobs
            .filter((job: { conclusion?: string | null }) => job.conclusion?.toLowerCase() === 'failure')
            .map((job: { name: string; steps?: Array<{ name?: string | null; conclusion?: string | null }> }) => ({
              name: job.name,
              failingStep: job.steps?.find((step) => step.conclusion?.toLowerCase() === 'failure')?.name ?? null,
            }))
            .slice(0, 3);
          const summaryLine = String(detail.logs ?? '')
            .split('\n')
            .find((line) => line.includes('##[error]') || line.toLowerCase().includes('error ts') || line.toLowerCase().includes('failed'))
            ?.replace(/^.*##\[error\]/, '')
            .trim() ?? null;
          setCiHoverDetails((current) => ({
            ...current,
            [hoveredItemKey]: {
              failingJobs,
              summaryLine,
            },
          }));
        })
        .catch(() => {});
    }
  }, [ciHoverDetails, hoveredItemKey, items, prHoverDetails]);

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
  const groupedHeaderStickyTop = repoPickerOpen ? 0 : 116;
  const missingGitHubScope = allRepos.length === 0 && !externalPanelRepo && !activeAgentRepo;

  if (!items.length) {
    return (
      <div style={{ padding: '24px 14px', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--t-text-muted)', fontWeight: 500 }}>
          {missingGitHubScope ? 'Connect GitHub to load repo activity' : 'No recent activity'}
        </div>
        <div style={{ fontSize: 11, color: 'var(--t-text-faint)', marginTop: 4 }}>
          {missingGitHubScope
            ? 'Authenticate GitHub and register a repository so issues, PRs, CI, and commits can flow here.'
            : 'Commits, issues, PRs, and CI runs will appear here'}
        </div>
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
        padding: '8px 8px 10px',
        background: 'linear-gradient(180deg, var(--t-panel) 0%, rgba(255,255,255,0) 100%)',
      }}>
        <div
          style={{
            borderRadius: 20,
            border: '1px solid var(--t-panel-border)',
            background: `linear-gradient(180deg, ${THEME_PANEL_GLASS} 0%, ${THEME_BG_CARD} 100%)`,
            boxShadow: 'var(--t-panel-shadow)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            overflow: 'hidden',
          }}
        >
          {/* Repo selector row */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 10px 6px',
          }}>
            <button
              type="button"
              onClick={() => setRepoPickerOpen(v => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                minHeight: 34,
                padding: '0 12px 0 10px',
                borderRadius: 12,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-chrome)',
                backdropFilter: 'blur(14px)',
                WebkitBackdropFilter: 'blur(14px)',
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
                fontSize: 11.5,
                fontWeight: 700,
                color: 'var(--t-text)',
                letterSpacing: '-0.01em',
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 999,
                  background: THEME_ACCENT_SOFT,
                  color: THEME_ACCENT,
                }}
              >
                <Folder size={11} strokeWidth={2} />
              </span>
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
                    onClick={() => (onReviewPR ?? onSelectPR)?.(openPr.number, openPr.repo)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      minHeight: 30,
                      padding: '0 10px',
                      borderRadius: 999,
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
                margin: '0 10px 8px',
                borderRadius: 14,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-chrome)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                boxShadow: 'var(--t-panel-shadow)',
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
                    background: selected ? THEME_ACCENT_SOFT : 'transparent',
                    color: selected ? THEME_ACCENT : 'var(--t-text)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    textAlign: 'left',
                  }}
                >
                  <Globe size={12} strokeWidth={2} style={{ color: selected ? THEME_ACCENT : 'var(--t-text-muted)' }} />
                  GitHub
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: 9,
                    color: 'var(--t-text-faint)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}>
                    registered
                  </span>
                  {selected ? <CheckCircle2 size={12} strokeWidth={2} style={{ color: THEME_ACCENT }} /> : null}
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
                    background: selected ? THEME_ACCENT_SOFT : 'transparent',
                    color: selected ? THEME_ACCENT : 'var(--t-text)',
                    fontSize: 12,
                    fontWeight: selected ? 600 : 400,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    textAlign: 'left',
                  }}
                >
                  <Folder size={12} strokeWidth={2} style={{ color: selected ? THEME_ACCENT : 'var(--t-text-muted)' }} />
                  {shortRepoLabel(r)}
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: 9,
                    color: 'var(--t-text-faint)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}>
                    {r.split('/').pop()}
                  </span>
                  {selected ? <CheckCircle2 size={12} strokeWidth={2} style={{ color: THEME_ACCENT }} /> : null}
                </button>
              );
            })}
            </div>
          ) : null}

          <div style={{
            padding: '0 10px 8px',
            fontSize: 10.5,
            color: 'var(--t-text-faint)',
            lineHeight: 1.4,
          }}>
            {scopeHelp}
          </div>
          {remoteScopeError ? (
            <div style={{
              padding: '0 10px 8px',
              fontSize: 10,
              color: '#b45309',
              lineHeight: 1.35,
            }}>
              GitHub data warning: {remoteScopeError}
            </div>
          ) : null}

          {/* Filter tabs */}
          <div style={{ padding: '0 10px 10px' }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: 4,
              borderRadius: 16,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-panel-hover)',
              boxShadow: 'inset 0 1px 0 var(--t-divider-subtle)',
            }}>
              {FILTER_TABS.map((tab) => {
                const active = filter === tab.key;
                const count = counts[tab.key];
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setFilter(tab.key)}
                    aria-label={count > 0 && tab.key !== 'all' ? `${tab.label} ${count}` : tab.label}
                    title={count > 0 && tab.key !== 'all' ? `${tab.label} ${count}` : tab.label}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 30,
                      height: 28,
                      padding: 0,
                      borderRadius: 12,
                      border: 'none',
                      background: active ? THEME_ACCENT_SOFT : 'transparent',
                      color: active ? THEME_ACCENT : 'var(--t-text-muted)',
                      cursor: 'pointer',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                      transition: 'all 150ms cubic-bezier(0.32, 0.72, 0, 1)',
                    }}
                  >
                    {tab.icon}
                    {count > 0 && tab.key !== 'all' ? (
                      <span style={{
                        position: 'absolute',
                        top: -2,
                        right: -2,
                        minWidth: 14,
                        height: 14,
                        padding: '0 4px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 999,
                        background: active ? THEME_ACCENT : 'rgba(148, 163, 184, 0.16)',
                        color: active ? '#ffffff' : 'var(--t-text-faint)',
                        boxShadow: '0 0 0 2px var(--t-panel)',
                        fontSize: 9,
                        fontWeight: 700,
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        lineHeight: 1,
                      }}>
                        {count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
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
            position: repoPickerOpen ? 'relative' : 'sticky',
            top: groupedHeaderStickyTop,
            background: 'var(--t-panel)',
            zIndex: 2,
          }}>
            {group.label}
          </div>
          {group.items.map((item, idx) => {
            const fi = feedIcon(item);
            const key = activityItemKey(item);
            const clickable = (item.kind === 'commit' && !!onSelectCommit) || item.kind === 'issue' || item.kind === 'ci';
            const handleClick = () => {
              if (item.kind === 'commit') {
                onSelectCommit?.(item.hash, item.repo ? { repo: item.repo } : undefined);
                return;
              }
              if (item.kind === 'issue') {
                if (onSelectIssue) {
                  onSelectIssue(item.number, item.repo);
                  return;
                }
              }
              // Issues/CI open in browser
              let url = '';
              if (item.kind === 'issue') url = `https://github.com/${item.repo}/issues/${item.number}`;
              else if (item.kind === 'ci') url = `https://github.com/${item.repo}/actions/runs/${item.id}`;
              if (url) window.open(url, '_blank');
            };
            const agentForEvent = item.kind === 'event'
              ? agents.find((agent) => agent.id === item.data.agentId)
              : null;
            const prDetail = item.kind === 'pr' ? prHoverDetails[key] ?? null : null;
            const ciDetail = item.kind === 'ci' ? ciHoverDetails[key] ?? null : null;
            const mergeRisk = item.kind === 'pr' ? mergeRiskLabel(prDetail) : null;

            return (
              <div
                key={key}
                onClick={clickable ? handleClick : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '7px 14px',
                  position: 'relative',
                  cursor: clickable ? 'pointer' : 'default',
                  transition: 'background 100ms ease',
                }}
                onMouseEnter={(e) => {
                  openHoverCard(key, (e.currentTarget as HTMLDivElement).getBoundingClientRect());
                  if (clickable) (e.currentTarget as HTMLDivElement).style.background = 'rgba(37,99,235,0.04)';
                }}
                onMouseMove={(e) => {
                  if (hoveredItemKey === key) {
                    setHoveredItemRect((e.currentTarget as HTMLDivElement).getBoundingClientRect());
                  }
                }}
                onMouseLeave={(e) => {
                  scheduleHoverClose();
                  if (clickable) (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                }}
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
                {item.kind === 'issue' ? (
                  <button
                    type="button"
                    title={`Launch agent on #${item.number}`}
                    onClick={(e) => { e.stopPropagation(); onLaunchTask?.({ kind: 'issue', repo: item.repo, number: item.number, title: item.title, body: item.body }); }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--t-text-muted)',
                      cursor: 'pointer',
                      flexShrink: 0,
                      padding: 0,
                      transition: 'color 120ms, background 120ms',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#2563eb'; e.currentTarget.style.background = 'rgba(37,99,235,0.08)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-muted)'; e.currentTarget.style.background = 'transparent'; }}
                  >
                    <PlayCircle size={13} strokeWidth={2} />
                  </button>
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

                {hoveredItemKey === key ? (
                  <BlueGlassHoverCard
                    eyebrow={item.kind === 'commit'
                      ? 'Commit'
                      : item.kind === 'pr'
                        ? 'Pull Request'
                        : item.kind === 'ci'
                          ? 'CI Run'
                          : item.kind === 'issue'
                            ? 'Issue'
                            : 'Activity'}
                    title={item.kind === 'commit'
                      ? item.message
                      : item.kind === 'event'
                        ? item.data.title
                        : item.kind === 'issue'
                          ? `#${item.number} ${item.title}`
                          : item.kind === 'pr'
                            ? `#${item.number} ${item.title}`
                            : item.title}
                    subtitle={item.kind === 'pr'
                        ? `${item.author} • ${item.branch}`
                      : item.kind === 'ci'
                        ? `${item.workflow} • ${item.branch}`
                        : item.kind === 'issue'
                          ? `${item.author} opened this in ${shortRepoLabel(item.repo)}`
                          : item.kind === 'commit'
                            ? `${shortRepoLabel(item.repo)} • ${item.hash}`
                            : agentForEvent
                              ? `${agentForEvent.name} • ${agentForEvent.model}`
                              : item.data.timestamp}
                    anchorRect={hoveredItemRect}
                    interactive
                    onMouseEnter={() => {
                      if (hoverCloseTimerRef.current) {
                        clearTimeout(hoverCloseTimerRef.current);
                        hoverCloseTimerRef.current = null;
                      }
                    }}
                    onMouseLeave={scheduleHoverClose}
                    footer={item.kind === 'pr' ? (
                      <>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <BlueGlassMetricPill label="State" value={mergeRisk?.label ?? 'reviewing'} color={mergeRisk?.color ?? '#64748b'} />
                          <BlueGlassMetricPill label="Checks" value={`${item.checkSummary?.failed ?? 0} fail · ${item.checkSummary?.pending ?? 0} pending`} color={item.checkSummary?.failed ? '#dc2626' : item.checkSummary?.pending ? '#d97706' : '#1d4ed8'} />
                          <BlueGlassMetricPill label="Files" value={String(item.changedFiles)} color="rgba(15,23,42,0.78)" />
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {onLaunchTask ? (
                            <BlueGlassActionButton
                              icon={<PlayCircle size={12} strokeWidth={2} />}
                              label="Launch review"
                              onClick={() => onLaunchTask({
                                kind: 'pr',
                                repo: item.repo,
                                number: item.number,
                                title: item.title,
                                branch: item.branch,
                              })}
                            />
                          ) : null}
                          {onReviewPR ? (
                            <BlueGlassActionButton
                              icon={<GitPullRequest size={12} strokeWidth={2} />}
                              label="Review"
                              onClick={() => onReviewPR(item.number, item.repo)}
                            />
                          ) : null}
                          {onSelectPR ? (
                            <BlueGlassActionButton
                              icon={<ArrowRight size={12} strokeWidth={2} />}
                              label="Open full PR"
                              onClick={() => onSelectPR(item.number, item.repo)}
                            />
                          ) : null}
                          <BlueGlassActionButton
                            icon={<ExternalLink size={12} strokeWidth={2} />}
                            label="Open on GitHub"
                            onClick={() => window.open(`https://github.com/${item.repo}/pull/${item.number}`, '_blank', 'noopener,noreferrer')}
                          />
                        </div>
                      </>
                    ) : item.kind === 'ci' ? (
                      <>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <BlueGlassMetricPill label="Result" value={item.conclusion || item.status} color={item.conclusion === 'success' ? '#16a34a' : item.conclusion === 'failure' ? '#dc2626' : '#d97706'} />
                          <BlueGlassMetricPill label="Age" value={item.age} color="rgba(15,23,42,0.78)" />
                        </div>
                        <BlueGlassActionButton
                          icon={<ExternalLink size={12} strokeWidth={2} />}
                          label="Open Run"
                          onClick={() => window.open(`https://github.com/${item.repo}/actions/runs/${item.id}`, '_blank', 'noopener,noreferrer')}
                        />
                      </>
                    ) : item.kind === 'commit' ? (
                      <>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <BlueGlassMetricPill label="Hash" value={item.hash} color="#1d4ed8" />
                          <BlueGlassMetricPill label="Age" value={item.age} color="rgba(15,23,42,0.78)" />
                        </div>
                        {onSelectCommit ? (
                          <BlueGlassActionButton
                            icon={<GitCommit size={12} strokeWidth={2} />}
                            label="Open in Workspace"
                            onClick={() => onSelectCommit(item.hash, item.repo ? { repo: item.repo } : undefined)}
                          />
                        ) : null}
                      </>
                    ) : item.kind === 'issue' ? (
                      <>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <BlueGlassMetricPill label="Comments" value={String(item.comments)} color="#1d4ed8" />
                          <BlueGlassMetricPill
                            label="Owner"
                            value={item.assignees[0] ?? 'unassigned'}
                            color={item.assignees[0] ? 'rgba(15,23,42,0.78)' : '#d97706'}
                          />
                          <BlueGlassMetricPill label="Age" value={item.age} color="rgba(15,23,42,0.78)" />
                        </div>
                        <BlueGlassActionButton
                          icon={<PlayCircle size={12} strokeWidth={2} />}
                          label="Launch agent"
                          onClick={() => onLaunchTask?.({
                            kind: 'issue',
                            repo: item.repo,
                            number: item.number,
                            title: item.title,
                            body: item.body,
                          })}
                        />
                        <BlueGlassActionButton
                          icon={<ExternalLink size={12} strokeWidth={2} />}
                          label="Open Issue"
                          onClick={() => window.open(`https://github.com/${item.repo}/issues/${item.number}`, '_blank', 'noopener,noreferrer')}
                        />
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: 11, color: 'rgba(15, 23, 42, 0.62)' }}>{item.data.severity}</div>
                        {agentForEvent?.sessionKey && onSelectSession ? (
                          <BlueGlassActionButton
                            icon={<MessageSquare size={12} strokeWidth={2} />}
                            label="Steer agent"
                            onClick={() => onSelectSession(agentForEvent.sessionKey)}
                          />
                        ) : null}
                      </>
                    )}
                  >
                    {item.kind === 'event' ? (
                      <>
                        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(15, 23, 42, 0.76)' }}>
                          {item.data.detail}
                        </div>
                        <BlueGlassSparklineLane
                          segments={items
                            .filter((candidate): candidate is Extract<ActivityItem, { kind: 'event' }> => candidate.kind === 'event' && candidate.data.agentId === item.data.agentId)
                            .slice(0, 4)
                            .map((candidate, index) => ({
                              label: `${index + 1}`,
                              value: Math.max(1, 4 - index),
                              color: severityColor[candidate.data.severity] ?? '#64748b',
                            }))}
                        />
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8' }}>
                          Next move: steer the active runtime lane if this event changes priority.
                        </div>
                      </>
                    ) : item.kind === 'issue' ? (
                      <>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {item.labels.slice(0, 4).map((label) => (
                            <span
                              key={label.name}
                              style={{
                                padding: '2px 7px',
                                borderRadius: 999,
                                background: `#${label.color}18`,
                                color: `#${label.color}`,
                                fontSize: 10,
                                fontWeight: 700,
                              }}
                            >
                              {label.name}
                            </span>
                          ))}
                        </div>
                        {item.body ? (
                          <div
                            style={{
                              fontSize: 12,
                              lineHeight: 1.55,
                              color: 'rgba(15, 23, 42, 0.76)',
                              padding: '8px 10px',
                              borderRadius: 12,
                              background: 'rgba(255,255,255,0.28)',
                            }}
                          >
                            {item.body.length > 180 ? `${item.body.slice(0, 177).trimEnd()}…` : item.body}
                          </div>
                        ) : (
                          <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(15, 23, 42, 0.62)' }}>
                            No description yet. The thread context is still mostly in labels, assignment, and comments.
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'rgba(15, 23, 42, 0.66)' }}>
                          <span>Assignee: {item.assignees.length ? item.assignees.join(', ') : 'Unassigned'}</span>
                          <span>{item.comments} comment{item.comments === 1 ? '' : 's'}</span>
                        </div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8' }}>
                          Next move: assign or open the issue before it drifts out of the activity lane.
                        </div>
                      </>
                    ) : item.kind === 'ci' ? (
                      <>
                        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(15, 23, 42, 0.76)' }}>
                          {item.workflow} on <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace' }}>{item.branch}</span>
                        </div>
                        {ciDetail?.failingJobs?.length ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#dc2626' }}>
                              Failing jobs
                            </div>
                            {ciDetail.failingJobs.map((job) => (
                              <div
                                key={`${job.name}-${job.failingStep ?? 'none'}`}
                                style={{
                                  padding: '6px 8px',
                                  borderRadius: 10,
                                  background: 'rgba(255,255,255,0.28)',
                                  fontSize: 11,
                                  color: 'rgba(15, 23, 42, 0.78)',
                                }}
                              >
                                <div style={{ fontWeight: 700 }}>{job.name}</div>
                                {job.failingStep ? (
                                  <div style={{ marginTop: 2, color: 'rgba(15, 23, 42, 0.62)' }}>
                                    {job.failingStep}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {ciDetail?.summaryLine ? (
                          <div
                            style={{
                              fontSize: 11,
                              lineHeight: 1.5,
                              color: 'rgba(15, 23, 42, 0.74)',
                              padding: '7px 8px',
                              borderRadius: 10,
                              background: 'rgba(255,255,255,0.28)',
                            }}
                          >
                            {ciDetail.summaryLine}
                          </div>
                        ) : null}
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8' }}>
                          Next move: inspect the failing run and decide whether to review or steer the agent.
                        </div>
                      </>
                    ) : item.kind === 'pr' ? (
                      <>
                        <BlueGlassSparklineLane
                          segments={[
                            { label: 'Pass', value: item.checkSummary?.passed ?? 0, color: '#22c55e' },
                            { label: 'Fail', value: item.checkSummary?.failed ?? 0, color: '#ef4444' },
                            { label: 'Pending', value: item.checkSummary?.pending ?? 0, color: '#f59e0b' },
                          ]}
                        />
                        {item.failingChecks && item.failingChecks.length > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#dc2626' }}>
                              Top failing checks
                            </div>
                            {item.failingChecks.map((check) => (
                              <div
                                key={check}
                                style={{
                                  fontSize: 11,
                                  lineHeight: 1.45,
                                  color: 'rgba(15, 23, 42, 0.76)',
                                  padding: '6px 8px',
                                  borderRadius: 10,
                                  background: 'rgba(255,255,255,0.28)',
                                }}
                              >
                                {check}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(15, 23, 42, 0.76)' }}>
                          Branch <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace' }}>{item.branch}</span> has an active merge path.
                        </div>
                        {prDetail?.files?.length ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#1d4ed8' }}>
                              Changed files
                            </div>
                            {prDetail.files.slice(0, 3).map((file) => (
                              <div
                                key={file.path}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '6px 8px',
                                  borderRadius: 10,
                                  background: 'rgba(255,255,255,0.28)',
                                  fontSize: 11,
                                }}
                              >
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'rgba(15,23,42,0.78)' }}>
                                  {file.path}
                                </span>
                                <span style={{ color: '#16a34a', fontWeight: 700 }}>+{file.additions}</span>
                                <span style={{ color: '#dc2626', fontWeight: 700 }}>-{file.deletions}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8' }}>
                          Next move: {mergeRisk?.label === 'merge ready'
                            ? 'review and merge while the branch is green.'
                            : mergeRisk?.label === 'conflicts'
                              ? 'resolve merge conflicts before stacking more work.'
                              : mergeRisk?.label === 'ci red'
                                ? 'inspect the failing checks before review.'
                                : 'review the PR before you steer more changes into this branch.'}
                        </div>
                      </>
                    ) : item.kind === 'commit' ? (
                      <>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {commitStack.map((commit) => (
                            <div
                              key={commit.hash}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '6px 8px',
                                borderRadius: 10,
                                background: commit.hash === item.hash ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.18)',
                              }}
                            >
                              <span style={{ fontSize: 10, fontFamily: '"SF Mono", ui-monospace, monospace', color: '#1d4ed8', fontWeight: 700 }}>{commit.hash}</span>
                              <span style={{ fontSize: 11, color: 'rgba(15, 23, 42, 0.76)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {commit.message}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8' }}>
                          Next move: open the commit in canvas and compare it against the active workspace.
                        </div>
                      </>
                    ) : null}
                  </BlueGlassHoverCard>
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
              {detail.assignees?.length ? (
                <>
                  <span>·</span>
                  <span>Assigned to {detail.assignees.join(', ')}</span>
                </>
              ) : null}
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
  activeSessionKey,
  selectedRepo,
  selectedRepoBranch,
  selectedRepoLocalPath,
  activeWorkspacePath,
  selectedRepoReadiness,
  onLaunchWorkspaceAgent,
  onLaunchWorkspaceTask,
  onSelectSession,
  onSelectIssue,
  onSelectCommit,
  onSelectPR,
  onReviewPR,
  onRepoRemoved,
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
  orchestratorPackets = [],
  ideWorkspaceSessions,
}: {
  activeSessionKey?: string | null;
  selectedRepo?: string | null;
  selectedRepoBranch?: string | null;
  selectedRepoLocalPath?: string | null;
  activeWorkspacePath?: string | null;
  selectedRepoReadiness?: RepoReadiness | null;
  onLaunchWorkspaceAgent?: (request: {
    repoPath: string;
    runtime?: 'codex' | 'claude-code';
    modelId?: string;
    initialText?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
  }) => Promise<void>;
  onLaunchWorkspaceTask?: (request: RepoTaskLaunchRequest) => Promise<void>;
  onSelectSession?: (sessionKey: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onRepoRemoved?: (repo: RepoRegistryEntry) => void;
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
  orchestratorPackets?: OrchestratorPacket[];
  ideWorkspaceSessions?: MobileInboxSnapshot['sessions'];
} = {}) {
  const [agents, setAgents] = useState<AgentDetail[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [gatewayReachable, setGatewayReachable] = useState(false);
  const [gatewayWarming, setGatewayWarming] = useState(false);
  const [fleetMeta, setFleetMeta] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [commits, setCommits] = useState<{ hash: string; message: string; age: string }[]>([]);
  const [issues, setIssues] = useState<GHIssue[]>([]);
  const [prs, setPrs] = useState<GHPullRequest[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [reposOpen, setReposOpen] = useState(true);
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);
  const [launchIntentNonce, setLaunchIntentNonce] = useState(0);
  const [addRepoIntentNonce, setAddRepoIntentNonce] = useState(0);
  const [repoRegistryState, setRepoRegistryState] = useState({
    loading: true,
    count: 0,
    hasError: false,
  });
  const hasSelectedRepo = Boolean(selectedRepoLocalPath);
  const scopedRepo = hasSelectedRepo ? (selectedRepo ?? null) : activeRepo;

  const launchRepoTask = useCallback(async (request: RepoTaskLaunchRequest) => {
    if (onLaunchWorkspaceTask) {
      await onLaunchWorkspaceTask(request);
      return;
    }
    const response = await fetch('/api/panel/repos');
    const data = await response.json() as {
      repos?: Array<{
        id: string;
        localPath: string;
        remoteUrl?: string | null;
        defaultBranch: string;
        setup: { installOnCreateWorkspace: boolean };
        readiness?: { state: string; nextAction?: string } | null;
      }>;
    };

    const repoEntry = (data.repos ?? []).find((repo) => {
      const remote = repoSlugFromRemoteUrl(repo.remoteUrl ?? null);
      return remote === request.repo;
    });

    if (!repoEntry) {
      throw new Error(`No local checkout is registered for ${request.repo}. Open the repo locally before launching an agent on it.`);
    }

    // Repo readiness gate — block launch if repo is in a broken state
    if (repoEntry.readiness?.state === 'blocked') {
      throw new Error(`Repo ${request.repo} is blocked: ${repoEntry.readiness.nextAction ?? 'resolve the issue before launching an agent.'}`);
    }

    const prompt = request.kind === 'issue'
      ? [
          `Work on GitHub issue #${request.number} in ${request.repo}: ${request.title}.`,
          'Start by reading the issue context, inspect the current repo state, implement the fix, run focused validation, and summarize the result.',
          request.body ? `Issue context:\n${request.body}` : null,
        ].filter(Boolean).join('\n\n')
      : [
          `Review GitHub PR #${request.number} in ${request.repo}: ${request.title}.`,
          `Head branch: ${request.branch ?? 'unknown'}.`,
          'Start by reading the PR context and changed files, validate the change locally, identify risks or regressions, and leave the repo in a reviewable state.',
        ].join('\n\n');

    const launchResponse = await fetch('/api/runtime/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runtime: 'codex',
        repoPath: repoEntry.localPath,
        prompt,
        taskName: request.kind === 'issue'
          ? `issue-${request.number}-${request.title}`
          : `pr-${request.number}-${request.title}`,
        baseBranch: repoEntry.defaultBranch,
        isolate: true,
        skipSetup: !repoEntry.setup.installOnCreateWorkspace,
      }),
    });

    const launchData = await launchResponse.json() as { error?: string; surfaceId?: string };
    if (!launchResponse.ok || !launchData.surfaceId) {
      throw new Error(launchData.error ?? 'Unable to launch agent task.');
    }

    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repoEntry.id }),
    }).catch(() => null);

    onSelectSession?.(launchData.surfaceId);
    setTimeout(() => fetchNowRef.current(), 800);
  }, [onLaunchWorkspaceTask, onSelectSession]);

  // Build workspace groups from agents
  const workspaceGroups = buildWorkspaceGroups(agents);
  const inferredRepo = useMemo(() => {
    const preferredGroup = workspaceGroups.find((group) => group.hasRunning && group.repo !== 'workspace')
      ?? workspaceGroups.find((group) => group.repo !== 'workspace')
      ?? null;
    return preferredGroup?.repo ?? null;
  }, [workspaceGroups]);
  const effectiveScopedRepo = scopedRepo ?? inferredRepo;

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
  const inventoryLoadedRef = useRef(false);

  // WS listener — triggers immediate re-fetch on agent status changes
  const wsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onInboxUpdate: () => { fetchNowRef.current(); },
    onReviewUpdate: () => { fetchNowRef.current(); setActivityRefreshKey(k => k + 1); },
  }), []);

  const { isConnected: wsConnected } = useSharedDesktopWs(undefined, wsCallbacks);

  // Fetch agent inventory + workspace/PR data in single pass (prevents pop-in/out)
  useEffect(() => {
    async function fetchAll() {
      if (!inventoryLoadedRef.current) setInventoryLoading(true);
      try {
        // Fetch inventory, workspace enrichments, and registered repos in parallel
        const [invRes, wsRes, repoRes] = await Promise.all([
          fetch(`/api/runtime/inventory?fleetMode=${typeof window !== 'undefined' ? localStorage.getItem('cortex-ide-fleet-mode') ?? 'smart' : 'smart'}`).catch(() => null),
          fetch('/api/panel/workspaces').catch(() => null),
          fetch('/api/panel/repos').catch(() => null),
        ]);

        // Parse inventory
        let newAgents: AgentDetail[] = [];
        let registeredRepoPaths = new Set<string>();
        let hasRegisteredRepoSnapshot = false;
        if (invRes?.ok) {
          const data = await invRes.json();
          newAgents = data.agents ?? [];
          const freshEvents: EventEntry[] = data.events ?? [];
          setEvents(prev => arraysMatchBy(prev, freshEvents, eventFp) ? prev : freshEvents);
          setFleetMeta(data.meta ?? null);
          setGatewayReachable(data.meta?.gatewayReachable ?? false);
          setGatewayWarming(data.meta?.gatewayFreshness === 'warming');
        }

        // Parse workspace data
        const wsMap = new Map<string, {
          branch: string;
          pr: AgentDetail['pr'];
          localDiff: AgentDetail['localDiff'];
          workspaceStatus: AgentDetail['workspaceStatus'];
          repoReadiness?: RepoReadiness;
          workflowStage?: WorkflowStageBadge | null;
        }>();
        if (wsRes?.ok) {
          const wsData = await wsRes.json();
          for (const ws of wsData.workspaces ?? []) {
            if (ws.sessionKey) {
              wsMap.set(ws.sessionKey, {
                branch: ws.branch,
                pr: ws.pr,
                localDiff: ws.localDiff,
                workspaceStatus: ws.status,
                repoReadiness: ws.readiness,
                workflowStage: ws.workflowStage ?? null,
              });
            }
          }
        }

        const worktreeMap = new Map<string, WorktreeInfo>();
        if (repoRes?.ok) {
          const repoData = await repoRes.json() as { repos?: Array<{ localPath: string }> };
          hasRegisteredRepoSnapshot = true;
          registeredRepoPaths = new Set((repoData.repos ?? [])
            .map((repo) => repo.localPath.trim().replace(/\/+$/, ''))
            .filter(Boolean));
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
            repoReadiness: ws?.repoReadiness ?? a.repoReadiness,
            workflowStage: ws?.workflowStage ?? a.workflowStage,
          };
        });

        const filteredAgents = enriched.filter((agent) => {
          if (!hasRegisteredRepoSnapshot) return true;
          const repoScopedPath = agent.worktree?.path?.trim().replace(/\/+$/, '')
            || agent.runtimeSurface?.cwd?.trim().replace(/\/+$/, '')
            || null;
          if (!repoScopedPath) return true;
          for (const repoPath of registeredRepoPaths) {
            if (repoScopedPath === repoPath || repoScopedPath.startsWith(`${repoPath}/`)) {
              return true;
            }
          }
          return false;
        });

        if (onAgentsUpdate) onAgentsUpdate(filteredAgents);
        setAgents(prev => arraysMatchBy(prev, filteredAgents, agentFp) ? prev : filteredAgents);
      } catch { /* silent */ }
      finally {
        if (!inventoryLoadedRef.current) {
          inventoryLoadedRef.current = true;
          setInventoryLoading(false);
        }
      }
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
    if (!effectiveScopedRepo) {
      setCommits([]);
      return;
    }
    const scopedRepo = effectiveScopedRepo;

    async function fetchCommits() {
      try {
        const res = await fetch(`/api/panel/commits?repo=${encodeURIComponent(scopedRepo)}&limit=10`);
        if (!res.ok) return;
        const data = await res.json();
        const parsed = (data.commits ?? []).map((commit: { hash?: string; message?: string; date?: string }) => ({
          hash: commit.hash ?? '',
          message: commit.message ?? '',
          age: commit.date ? relativeAge(commit.date) : '',
        }));
        setCommits(prev => arraysMatchBy(prev, parsed, c => c.hash) ? prev : parsed);
      } catch { /* silent */ }
    }
    void fetchCommits();
    const id = setInterval(fetchCommits, 30_000);
    return () => clearInterval(id);
  }, [effectiveScopedRepo]);

  // Fetch GitHub issues + PRs in a single effect (same dep + same cadence)
  useEffect(() => {
    if (!effectiveScopedRepo) {
      setIssues([]);
      setPrs([]);
      return;
    }

    const repoParam = effectiveScopedRepo ? `?repo=${encodeURIComponent(effectiveScopedRepo)}` : '';
    async function fetchGitHub() {
      const [issuesRes, prsRes] = await Promise.all([
        fetch(`/api/panel/issues${repoParam}`).catch(() => null),
        fetch(`/api/panel/prs${repoParam}`).catch(() => null),
      ]);
      if (issuesRes?.ok) {
        const data = await issuesRes.json();
        const fresh = data.issues ?? [];
        setIssues(prev => arraysMatchBy(prev, fresh, (i: GHIssue) => `${i.number}|${i.state ?? ''}`) ? prev : fresh);
      }
      if (prsRes?.ok) {
        const data = await prsRes.json();
        const fresh = data.prs ?? [];
        setPrs(prev => arraysMatchBy(prev, fresh, (p: GHPullRequest) => `${p.number}|${p.state}|${p.additions}|${p.deletions}`) ? prev : fresh);
      }
    }
    void fetchGitHub();
    const id = setInterval(fetchGitHub, 60_000);
    return () => clearInterval(id);
  }, [effectiveScopedRepo]);

  // Resolve repo → local path for file tree
  const [repoLocalPath, setRepoLocalPath] = useState<string | null>(null);
  useEffect(() => {
    if (selectedRepoLocalPath) {
      setRepoLocalPath(selectedRepoLocalPath);
      return;
    }
    if (!effectiveScopedRepo) { setRepoLocalPath(null); return; }
    fetch('/api/panel/repos')
      .then(r => r.json())
      .then(data => {
        const match = (data.repos ?? []).find((r: { remoteUrl?: string }) => {
          const url = (r.remoteUrl ?? '').replace(/\.git$/, '');
          return url.endsWith(effectiveScopedRepo);
        });
        setRepoLocalPath(match?.localPath ?? null);
      })
      .catch(() => setRepoLocalPath(null));
  }, [effectiveScopedRepo, selectedRepoLocalPath]);

  const activeWorkspaceGroup = useMemo(
    () => (expandedGroup ? workspaceGroups.find((group) => group.workspace === expandedGroup) ?? null : null),
    [expandedGroup, workspaceGroups],
  );
  const trackedWorkspaceCount = useMemo(
    () => workspaceGroups.filter((group) => group.repo !== 'workspace').length,
    [workspaceGroups],
  );
  const reviewWorkspaceCount = useMemo(
    () => workspaceGroups.filter((group) => (
      group.repo !== 'workspace'
      && group.agents.some((agent) => agent.workspaceStatus === 'in_review' || agent.status === 'reviewing')
    )).length,
    [workspaceGroups],
  );
  const preferredWorkspaceGroup = useMemo(
    () => activeWorkspaceGroup
      ?? (effectiveScopedRepo ? workspaceGroups.find((group) => group.repo === effectiveScopedRepo) ?? null : null)
      ?? workspaceGroups[0]
      ?? null,
    [activeWorkspaceGroup, effectiveScopedRepo, workspaceGroups],
  );
  const currentLaunchRepoPath = hasSelectedRepo ? (selectedRepoLocalPath ?? repoLocalPath) : repoLocalPath;
  const hasRegisteredRepos = !repoRegistryState.loading && repoRegistryState.count > 0;
  const workspacesSummary = !hasRegisteredRepos
    ? null
    : inventoryLoading
      ? 'Loading repositories and workspaces...'
      : trackedWorkspaceCount > 0 || reviewWorkspaceCount > 0
        ? `${trackedWorkspaceCount} live · ${reviewWorkspaceCount} in review`
        : null;
  const activityAgentRepoById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agentRepoSlug(agent)])),
    [agents],
  );
  const visibleActivityEvents = useMemo(() => {
    return events.filter((event) => {
      const eventRepo = activityAgentRepoById.get(event.agentId) ?? null;
      if (!eventRepo) return false;
      if (!effectiveScopedRepo) return true;
      return eventRepo === effectiveScopedRepo;
    });
  }, [activityAgentRepoById, effectiveScopedRepo, events]);
  const hasGitHubScopedSummary = Boolean(effectiveScopedRepo);
  const activityItemCount = hasGitHubScopedSummary
    ? visibleActivityEvents.length + commits.length + issues.length + prs.length
    : null;
  const activityDockTitle = effectiveScopedRepo ? 'Repo activity' : 'Activity';
  const latestEventSummary = hasGitHubScopedSummary
    ? (prs[0] ? `PR #${prs[0].number} · ${prs[0].title}` : null)
      ?? (issues[0] ? `Issue #${issues[0].number} · ${issues[0].title}` : null)
      ?? (commits[0]?.message ?? compactActivitySummaryLabel(visibleActivityEvents[0]?.title))
    : (hasRegisteredRepos
      ? 'GitHub activity across your registered repos.'
      : 'Connect GitHub and add a repo to load activity.');
  const activitySummary = compactActivitySummaryLabel(latestEventSummary);
  const launchIntent = launchIntentNonce > 0 && currentLaunchRepoPath
    ? { repoPath: currentLaunchRepoPath, nonce: launchIntentNonce }
    : null;
  const addRepoIntent = addRepoIntentNonce > 0
    ? { nonce: addRepoIntentNonce }
    : null;
  const titlebarSpacerHeight = isTauri() ? 38 : 10;

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'transparent',
    } as React.CSSProperties}
    >
      {/* ── Titlebar spacer ── */}
      <div style={{
        height: titlebarSpacerHeight,
        flexShrink: 0,
        WebkitAppRegion: 'drag' as unknown as string,
      } as React.CSSProperties} />

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          WebkitOverflowScrolling: 'touch',
          paddingTop: isTauri() ? 2 : 0,
          paddingBottom: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        } as React.CSSProperties}
        className="hide-scrollbar"
      >
        <SidebarSection
          title="Workspaces"
          summary={workspacesSummary}
          accent="#ef4444"
          open={reposOpen}
          onToggle={() => setReposOpen((current) => !current)}
          headerAction={(
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <button
                type="button"
                aria-label="Add repository"
                onClick={() => {
                  setReposOpen(true);
                  setAddRepoIntentNonce((current) => current + 1);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 26,
                  height: 26,
                  padding: 0,
                  borderRadius: 8,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  cursor: 'pointer',
                  appearance: 'none',
                  WebkitAppearance: 'none',
                  lineHeight: 0,
                  transition: 'background 140ms ease, color 140ms ease',
                }}
                onMouseEnter={(event) => {
                  const target = event.currentTarget;
                  target.style.background = 'var(--t-panel-hover)';
                  target.style.color = 'var(--t-text)';
                }}
                onMouseLeave={(event) => {
                  const target = event.currentTarget;
                  target.style.background = 'transparent';
                  target.style.color = 'var(--t-text-muted)';
                }}
              >
                <Plus size={15} strokeWidth={2.2} />
              </button>
            </div>
          )}
        >
          {fleetMeta?.mode === 'stale' ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 16,
              background: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.15)',
              fontSize: 11,
              color: '#d97706',
              fontWeight: 600,
            }}>
              <span style={{ fontSize: 13 }}>⏳</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                Showing cached session state while the gateway reconnects. Live updates resume automatically.
              </span>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  border: 'none',
                  borderRadius: 999,
                  background: 'rgba(217, 119, 6, 0.12)',
                  color: '#b45309',
                  padding: '4px 8px',
                  cursor: 'pointer',
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  flexShrink: 0,
                }}
              >
                Reload
              </button>
            </div>
          ) : gatewayReachable && gatewayWarming ? (
            <div style={{
              padding: '8px 2px 2px',
              fontSize: 11,
              color: THEME_ACCENT,
            }}>
              Loading live workspaces...
            </div>
          ) : null}
          <RepoRegistrySection
            onLaunchComplete={() => { fetchNowRef.current(); }}
            onSelectSession={onSelectSession}
            onSelectPR={onSelectPR}
            onReviewPR={onReviewPR}
            onRepoRemoved={(repo) => {
              fetchNowRef.current();
              onRepoRemoved?.(repo);
            }}
            onLaunchWorkspaceAgent={onLaunchWorkspaceAgent}
            onRegistryStateChange={setRepoRegistryState}
            activeSessionKey={activeSessionKey}
            activeRepoLocalPath={currentLaunchRepoPath}
            activeWorkspacePath={activeWorkspacePath ?? selectedRepoLocalPath ?? null}
            sectionOpen={reposOpen}
            onSectionOpenChange={setReposOpen}
            launchIntent={launchIntent}
            addIntent={addRepoIntent}
            orchestratorPackets={orchestratorPackets}
            ideWorkspaceSessions={ideWorkspaceSessions}
            hideHeader
          />
        </SidebarSection>

        <div
          style={{
            position: 'sticky',
            bottom: 0,
            marginTop: 4,
            paddingLeft: 4,
            paddingRight: 4,
            paddingBottom: 2,
            zIndex: 1,
          }}
        >
          <ActivityDock
            title={activityDockTitle}
            count={activityItemCount}
            summary={activitySummary}
            open={activityOpen}
            onToggle={() => setActivityOpen((current) => !current)}
          >
            <ActivityFeed
              events={visibleActivityEvents}
              commits={commits}
              agents={agents}
              onSelectSession={onSelectSession}
              onSelectIssue={onSelectIssue}
              onSelectCommit={onSelectCommit}
              onSelectPR={onSelectPR}
              onReviewPR={onReviewPR}
              onLaunchTask={(request) => {
                void launchRepoTask(request).catch((error) => {
                  window.alert(error instanceof Error ? error.message : 'Unable to launch repo task.');
                });
              }}
              activeRepo={effectiveScopedRepo}
              activeAgentKey={hasSelectedRepo ? null : (expandedGroup ? agents.find(a => a.workspace === expandedGroup)?.sessionKey ?? null : null)}
              refreshKey={activityRefreshKey}
            />
          </ActivityDock>
        </div>

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
        @keyframes reviewingBreathe {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.25); opacity: 0.7; }
        }
        @keyframes reviewingRing {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(2.8); opacity: 0; }
        }
        .cortex-dark-scroll::-webkit-scrollbar {
          width: 10px;
        }
        .cortex-dark-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .cortex-dark-scroll::-webkit-scrollbar-thumb {
          background: var(--t-divider-strong);
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        .cortex-dark-scroll::-webkit-scrollbar-thumb:hover {
          background: var(--t-text-faint);
          border: 2px solid transparent;
          background-clip: padding-box;
        }
      `}</style>
    </div>
  );
});
