'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, FolderOpen, GitBranch, GitPullRequest, Plus, Settings2, Trash2, X } from '../lucide-shims';
import { BlueGlassActionButton, BlueGlassHoverCard, BlueGlassMetricPill, BlueGlassSparklineLane } from '@/components/desktop/BlueGlassHoverCard';
import type {
  RepoReadinessState,
  RepoRegistryEntry,
  RepoSetupConfig,
  RepoSetupEnvMode,
  ValidatedRepoCandidate,
} from '@/lib/repos/types';
import {
  FOCUS_REPO_SETUP_EVENT,
  OPEN_REPO_WORKSPACE_EVENT,
  type FocusRepoSetupDetail,
  type OpenRepoWorkspaceDetail,
} from '@/lib/desktop/events';
import {
  orchestratorRuntimeTone,
  orchestratorStatusTone,
} from '@/lib/orchestrator/display';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { WorktreeInfo, WorktreeStatus } from '@/lib/worktree/types';

interface JsonErrorShape {
  error?: string;
}

export interface WorkspaceCreateResult {
  id: string;
  branch: string;
  path: string;
  baseBranch: string;
}

export interface WorkspaceAgentLaunchRequest {
  repoPath: string;
  runtime?: 'codex' | 'claude-code';
  modelId?: string;
  initialText?: string;
  autoSend?: boolean;
  createNew?: boolean;
  label?: string;
}

export interface RepoWorktreeSummary {
  worktrees: WorktreeInfo[];
  conflicts: {
    safe: boolean;
    count: number;
  };
  totalDiskUsage: number;
}

export interface BranchAgent {
  name: string;
  agentName: string;
  sessionKey: string;
  color: string;
  runtime: string;
  status: string;
  currentTask?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export type IdeWorkspaceSession = MobileInboxSnapshot['sessions'][number];

export interface BranchInfo {
  name: string;
  current: boolean;
  lastCommitAge: string;
  lastCommitMessage: string;
  lastCommitUnix: number;
  isWorktree: boolean;
  worktreePath?: string;
  ahead: number;
  behind: number;
  additions?: number;
  deletions?: number;
  isStale: boolean;
  staleDays?: number;
  diskSize?: string;
}

export interface RepoPreviewPullRequest {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  url?: string;
  reviewDecision?: string;
  statusCheckRollup?: Array<{ name?: string | null; conclusion?: string | null; status?: string | null }>;
}

export interface RepoPreviewPullRequestDetail {
  mergeable: boolean;
  checksStatus: 'success' | 'failure' | 'pending' | 'unknown';
  reviewDecision: string | null;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
}

export const THEME_ACCENT = 'var(--t-accent, #2563eb)';
export const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
export const THEME_ACCENT_SOFT_STRONG = 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.14))';
export const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
export const THEME_ACCENT_RING = 'var(--t-accent-ring, rgba(37, 99, 235, 0.15))';
export const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
export const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';
export const THEME_SUCCESS_SOFT = 'rgba(78, 166, 114, 0.12)';
export const THEME_SUCCESS_BORDER = 'rgba(78, 166, 114, 0.18)';
export const THEME_SUCCESS_TEXT = '#78b791';
export const THEME_DANGER_SOFT = 'rgba(201, 112, 112, 0.12)';
export const THEME_DANGER_BORDER = 'rgba(201, 112, 112, 0.2)';
export const THEME_DANGER_TEXT = '#d28787';
export const THEME_WORKTREE_SOFT = 'rgba(245, 158, 11, 0.12)';
export const THEME_WORKTREE_SOFT_STRONG = 'rgba(245, 158, 11, 0.18)';
export const THEME_WORKTREE_BORDER = 'rgba(245, 158, 11, 0.24)';
export const THEME_WORKTREE_TEXT = '#f6b24d';

export function formatRelativeTime(value: string | null) {
  if (!value) return 'Never';

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'Unknown';

  const delta = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (delta < minute) return 'Just now';
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))}m ago`;
  if (delta < day) return `${Math.max(1, Math.round(delta / hour))}h ago`;
  if (delta < 7 * day) return `${Math.max(1, Math.round(delta / day))}d ago`;

  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Strips the `worktree/<runtime>/` prefix that Cortex IDE uses to namespace
 * agent-spawned branches. The full name stays available as a tooltip — this
 * is purely a display-density helper so the branch row can show the slug
 * portion (the part humans actually care about) instead of the prefix.
 *
 *   worktree/codex/create-a-new-file-at-docs       → create-a-new-file-at-docs
 *   worktree/claude-code/fix-login-race            → fix-login-race
 *   feat/meta-chat                                 → feat/meta-chat (unchanged)
 */
export function formatBranchDisplayName(name: string): string {
  const match = name.match(/^worktree\/(?:codex|claude-code)\/(.+)$/);
  return match ? match[1] : name;
}

/**
 * Compact "Xh ago" / "Xd ago" formatter used by branch/packet list rows.
 * Mirrors the Superconductor reference density — short, always two chars of
 * unit, no localization overhead. Accepts a unix-ms timestamp.
 */
export function formatCompactAge(unixMs: number): string {
  if (!unixMs || Number.isNaN(unixMs)) return '';
  const delta = Math.max(0, Date.now() - unixMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  if (delta < week) return `${Math.floor(delta / day)}d ago`;
  if (delta < 30 * day) return `${Math.floor(delta / week)}w ago`;
  if (delta < 365 * day) return `${Math.floor(delta / (30 * day))}mo ago`;
  return `${Math.floor(delta / (365 * day))}y ago`;
}

export function shortenPath(value: string) {
  const userPath = value.replace(/^\/Users\/[^/]+/, '~');
  if (userPath !== value) return userPath;
  return value.replace(/^\/home\/[^/]+/, '~');
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function worktreeStageTone(status?: WorktreeStatus | null) {
  switch (status) {
    case 'creating':
      return {
        label: 'Queued',
        color: '#d97706',
        background: 'rgba(245, 158, 11, 0.12)',
        border: 'rgba(245, 158, 11, 0.2)',
      };
    case 'setup':
    case 'cleaning':
      return {
        label: 'Waiting',
        color: '#64748b',
        background: 'rgba(148, 163, 184, 0.12)',
        border: 'rgba(148, 163, 184, 0.2)',
      };
    case 'active':
      return {
        label: 'Working',
        color: '#15803d',
        background: 'rgba(34, 197, 94, 0.12)',
        border: 'rgba(34, 197, 94, 0.2)',
      };
    case 'merging':
      return {
        label: 'Reviewing',
        color: '#7c3aed',
        background: 'rgba(124, 58, 237, 0.12)',
        border: 'rgba(124, 58, 237, 0.2)',
      };
    case 'stale':
      return {
        label: 'Needs attention',
        color: '#d97706',
        background: 'rgba(245, 158, 11, 0.12)',
        border: 'rgba(245, 158, 11, 0.22)',
      };
    default:
      return {
        label: 'Ready',
        color: '#2563eb',
        background: 'rgba(37, 99, 235, 0.12)',
        border: 'rgba(37, 99, 235, 0.2)',
      };
  }
}

export function sanitizeWorkspaceName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export function getWorkspaceBranchPreview(value: string) {
  const slug = sanitizeWorkspaceName(value) || 'workspace';
  return `worktree/workspace/${slug}`;
}

export function githubUrlFromRemote(remoteUrl: string | null) {
  if (!remoteUrl) return null;

  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (httpsMatch?.[1]) return `https://github.com/${httpsMatch[1]}`;

  return null;
}

export function githubSlugFromRemote(remoteUrl: string | null) {
  if (!remoteUrl) return null;

  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (httpsMatch?.[1]) return httpsMatch[1];

  return null;
}

export function pointWithinRect(rect: DOMRect, x: number, y: number) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function resolveFloatingPanelPosition(anchorRect: DOMRect, width: number) {
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1440;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 900;
  const margin = 16;

  let left = anchorRect.right + 14;
  if (left + width + margin > viewportWidth) {
    left = Math.max(margin, anchorRect.left - width - 14);
  }

  let top = anchorRect.top;
  const estimatedHeight = 240;
  if (top + estimatedHeight + margin > viewportHeight) {
    top = Math.max(margin, viewportHeight - estimatedHeight - margin);
  }

  return { left, top };
}

export function defaultWorkspaceName(repoName: string) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `${repoName}-${stamp}`;
}

export function normalizeSetupDraft(setup: RepoSetupConfig): RepoSetupConfig {
  const envFiles = Array.from(
    new Set(
      setup.envFiles
        .map((file) => file.trim())
        .filter(Boolean),
    ),
  );

  return {
    ...setup,
    envFiles,
    installCommand: setup.installCommand?.trim() || null,
    buildCommand: setup.buildCommand?.trim() || null,
    devCommand: setup.devCommand?.trim() || null,
    defaultPort: setup.defaultPort ?? null,
  };
}

export function repoReadinessPalette(state?: RepoReadinessState) {
  switch (state) {
    case 'ready':
      return { background: THEME_SUCCESS_SOFT, border: THEME_SUCCESS_BORDER, color: THEME_SUCCESS_TEXT };
    case 'needs_setup':
      return { background: THEME_ACCENT_SOFT, border: THEME_ACCENT_BORDER, color: THEME_ACCENT };
    case 'blocked':
      return { background: THEME_WORKTREE_SOFT, border: THEME_WORKTREE_BORDER, color: THEME_WORKTREE_TEXT };
    default:
      return { background: 'var(--t-divider-subtle)', border: 'var(--t-panel-border)', color: 'var(--t-text-secondary)' };
  }
}

export function repoReadinessDisplayLabel(state?: RepoReadinessState, label?: string | null) {
  if (state === 'blocked') return 'Needs attention';
  return label ?? null;
}

export function repoReadinessExplanation(readiness?: RepoRegistryEntry['readiness']) {
  if (!readiness) return null;
  return [readiness.summary, readiness.nextAction].filter(Boolean).join(' ');
}

export function worktreeStatusExplanation(worktree?: WorktreeInfo | null) {
  if (!worktree) return null;
  switch (worktree.status) {
    case 'stale':
      return 'This worktree is no longer current. Reopen it or launch a fresh workspace before trusting it for new work.';
    case 'creating':
      return 'This workspace is still being created. Wait for setup to finish before using it.';
    case 'setup':
    case 'cleaning':
      return 'This workspace is still preparing its environment. It is not ready for active work yet.';
    case 'merging':
      return 'This workspace is in a review or merge phase. Finish the merge flow before treating it as clean.';
    default:
      return null;
  }
}

export function sortRepoEntries(entries: RepoRegistryEntry[]) {
  return [...entries].sort((a, b) => {
    const aTime = new Date(a.lastOpenedAt ?? a.addedAt).getTime();
    const bTime = new Date(b.lastOpenedAt ?? b.addedAt).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  const data = (await response.json().catch(() => ({}))) as T & JsonErrorShape;
  if (!response.ok) {
    throw new Error(data.error || 'Request failed.');
  }
  return data;
}

export function mergeRiskLabel(detail: RepoPreviewPullRequestDetail | null): {
  label: string;
  color: string;
} {
  if (!detail) return { label: 'warming', color: '#64748b' };
  if (!detail.mergeable) return { label: 'conflicts', color: '#dc2626' };
  if (detail.checksStatus === 'failure') return { label: 'ci red', color: '#dc2626' };
  if (detail.checksStatus === 'pending') return { label: 'checks pending', color: THEME_ACCENT };
  if (detail.reviewDecision === 'CHANGES_REQUESTED') return { label: 'changes requested', color: '#dc2626' };
  if (detail.reviewDecision === 'REVIEW_REQUIRED') return { label: 'review pending', color: THEME_ACCENT };
  return { label: 'merge ready', color: '#16a34a' };
}

export function compactText(value: string | null | undefined, max = 56) {
  const text = value?.trim() ?? '';
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function normalizeSessionTaskLabel(value?: string | null) {
  const raw = value?.trim();
  if (!raw) return null;
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
  const summary = cleaned || raw;
  return summary.charAt(0).toLowerCase() === summary.charAt(0)
    ? `${summary.charAt(0).toUpperCase()}${summary.slice(1)}`
    : summary;
}

/** Official Codex logo — uses actual brand asset */
export function CodexIcon({ size = 14 }: { size?: number; color?: string }) {
  return (
    <img
      src="/logos/codex.webp"
      alt="Codex"
      width={size}
      height={size}
      style={{ display: 'block', objectFit: 'contain', flexShrink: 0 } as React.CSSProperties}
    />
  );
}

/** Official Claude logo — uses actual brand asset */
export function ClaudeIcon({ size = 14 }: { size?: number; color?: string }) {
  return (
    <img
      src="/logos/claude.png"
      alt="Claude"
      width={size}
      height={size}
      style={{ display: 'block', objectFit: 'contain', flexShrink: 0 } as React.CSSProperties}
    />
  );
}

export function runtimeBadgeTone(runtime?: string | null) {
  switch (runtime) {
    case 'claude-code':
      return {
        label: 'Claude Code',
        shortLabel: 'CC',
        color: '#8b5cf6',
        background: 'rgba(139, 92, 246, 0.12)',
        border: 'rgba(139, 92, 246, 0.18)',
      };
    default:
      return {
        label: 'Codex',
        shortLabel: 'CX',
        color: '#10b981',
        background: 'rgba(16, 185, 129, 0.12)',
        border: 'rgba(16, 185, 129, 0.18)',
      };
  }
}

export function sessionStatusTone(status?: string | null) {
  // Apple traffic-light system: green (active), amber (waiting), red (error), gray (idle)
  switch (status) {
    case 'running':
      return { label: 'Working', color: '#34c759', glow: 'rgba(52, 199, 89, 0.22)' };
    case 'reviewing':
      return { label: 'Reviewing', color: '#34c759', glow: 'rgba(52, 199, 89, 0.22)' };
    case 'waiting':
      return { label: 'Waiting', color: '#ff9f0a', glow: 'rgba(255, 159, 10, 0.22)' };
    case 'blocked':
    case 'failed':
      return { label: 'Blocked', color: '#ff3b30', glow: 'rgba(255, 59, 48, 0.22)' };
    case 'completed':
      return { label: 'Done', color: '#34c759', glow: 'rgba(52, 199, 89, 0.22)' };
    default:
      return { label: 'Idle', color: '#8e8e93', glow: 'rgba(142, 142, 147, 0.18)' };
  }
}

// ── Braille spinner for working agents ──
// Braille dot pattern from the viral CLI spinners tweet.
// Classic rotating dot — compact, elegant, unmistakable "alive" signal.
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function AgentSpinner({
  status,
  size = 6,
}: {
  status?: string | null;
  size?: number;
}) {
  const [frame, setFrame] = useState(0);
  const isActive = status === 'running' || status === 'reviewing';
  const tone = sessionStatusTone(status);

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => {
      setFrame((f) => (f + 1) % BRAILLE_FRAMES.length);
    }, 80);
    return () => window.clearInterval(timer);
  }, [isActive]);

  if (!isActive) {
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: tone.color,
          boxShadow: `0 0 6px ${tone.glow}`,
          flexShrink: 0,
          display: 'inline-block',
        }}
      />
    );
  }

  const fontSize = Math.max(size + 4, 10);

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: fontSize,
        height: fontSize,
        fontSize,
        lineHeight: 1,
        color: tone.color,
        textShadow: `0 0 8px ${tone.glow}`,
        flexShrink: 0,
        fontFamily: 'monospace',
        letterSpacing: 0,
      }}
    >
      {BRAILLE_FRAMES[frame]}
    </span>
  );
}

export function sessionSortValue(status?: string | null) {
  switch (status) {
    case 'running':
      return 0;
    case 'reviewing':
      return 1;
    case 'waiting':
      return 2;
    case 'blocked':
    case 'failed':
      return 3;
    default:
      return 4;
  }
}

export function compareBranchAgents(left: BranchAgent, right: BranchAgent) {
  const statusDelta = sessionSortValue(left.status) - sessionSortValue(right.status);
  if (statusDelta !== 0) return statusDelta;
  return left.sessionKey.localeCompare(right.sessionKey);
}

export function branchSessionLabel(agent: BranchAgent) {
  const summary = compactText(normalizeSessionTaskLabel(agent.currentTask), 60);
  if (summary) return summary;
  const runtime = runtimeBadgeTone(agent.runtime).label;
  return compactText(agent.agentName || agent.name || `${runtime} session`, 60) ?? `${runtime} session`;
}

export function repoOwnsPath(repoPath: string, candidate?: string | null) {
  const normalizedRepo = repoPath.trim().replace(/\/+$/, '');
  const normalizedCandidate = candidate?.trim().replace(/\/+$/, '');
  if (!normalizedCandidate) return false;
  return normalizedCandidate === normalizedRepo || normalizedCandidate.startsWith(`${normalizedRepo}/`);
}

export function repoNameFromWorkspacePath(workspacePath?: string | null) {
  const trimmed = workspacePath?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/^~\//, '').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

export function buildBranchAgentMapFromIdeSessions(sessions: IdeWorkspaceSession[]) {
  const map = new Map<string, Map<string, BranchAgent[]>>();
  for (const session of sessions) {
    const repoKey = repoNameFromWorkspacePath(session.workspace);
    const branch = session.branch?.trim();
    if (!repoKey || !branch || branch.startsWith('surface/')) continue;

    if (!map.has(repoKey)) map.set(repoKey, new Map());
    const branchMap = map.get(repoKey)!;
    if (!branchMap.has(branch)) branchMap.set(branch, []);
    const existing = branchMap.get(branch)!;
    if (existing.some((agent) => agent.sessionKey === session.sessionKey)) continue;

    const runtimeTone = runtimeBadgeTone(session.runtime);
    existing.push({
      name: runtimeTone.label,
      agentName: session.name || runtimeTone.label,
      sessionKey: session.sessionKey,
      color: runtimeTone.color,
      runtime: session.runtime,
      status: session.status,
      currentTask: session.currentTask ?? null,
    });
  }
  return map;
}

export function packetMatchesBranch(
  packet: OrchestratorPacket,
  repo: RepoRegistryEntry,
  branch: BranchInfo,
  branchAgents: BranchAgent[],
) {
  if (packet.status === 'archived' || packet.status === 'released') return false;
  if (packet.lane?.sessionKey && branchAgents.some((agent) => agent.sessionKey === packet.lane?.sessionKey)) {
    return true;
  }
  if (!repoOwnsPath(repo.localPath, packet.lane?.repoPath ?? packet.workspaceTargetPath)) {
    return false;
  }
  const targetBranch = packet.branchTarget.trim();
  if (!targetBranch) return branch.current;
  return targetBranch === branch.name;
}

export function GlassModal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9998,
          background: 'rgba(0, 0, 0, 0.05)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
        } as React.CSSProperties}
      />
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: `min(${width}px, calc(100vw - 28px))`,
          maxHeight: 'calc(100vh - 28px)',
          zIndex: 9999,
          background: 'rgba(255, 255, 255, 0.18)',
          backdropFilter: 'blur(80px) saturate(2.2)',
          WebkitBackdropFilter: 'blur(80px) saturate(2.2)',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          borderRadius: 16,
          boxShadow: '0 24px 80px rgba(0, 0, 0, 0.08), 0 8px 32px rgba(0, 0, 0, 0.04), inset 0 0.5px 0 rgba(255, 255, 255, 0.4), inset 0 -0.5px 0 rgba(255, 255, 255, 0.1)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            padding: 'var(--cortex-dialog-header-padding)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.14)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--t-text)',
                letterSpacing: '-0.02em',
              }}
            >
              {title}
            </div>
            {subtitle ? (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 12,
                  lineHeight: 1.45,
                  color: 'var(--t-text-muted)',
                }}
              >
                {subtitle}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              border: 'none',
              background: 'rgba(255, 255, 255, 0.14)',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <X size={14} strokeWidth={2.25} />
          </button>
        </div>

        <div
          style={{
            padding: 'var(--cortex-dialog-body-padding)',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {children}
        </div>

        {footer ? (
          <div
            style={{
              padding: 'var(--cortex-dialog-footer-padding)',
              borderTop: '1px solid rgba(255, 255, 255, 0.14)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 10,
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </>,
    document.body,
  );
}

export function RepoActionButton({
  label,
  icon,
  onClick,
  disabled = false,
  active = false,
  danger = false,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
}) {
  const color = danger ? '#ef4444' : active ? 'var(--t-text)' : 'var(--t-text-secondary)';
  const border = danger ? 'rgba(239, 68, 68, 0.18)' : active ? 'rgba(37, 99, 235, 0.16)' : 'var(--t-btn-secondary-border)';
  const background = danger ? 'rgba(239, 68, 68, 0.08)' : active ? 'rgba(37, 99, 235, 0.08)' : 'var(--t-panel-hover)';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 32,
        paddingTop: 8,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 10,
        borderRadius: 10,
        border: `1px solid ${border}`,
        background,
        color,
        fontSize: 11,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        transition: 'all 150ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export function SetupModeButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        minHeight: 34,
        paddingTop: 8,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 10,
        borderRadius: 10,
        border: selected ? '1px solid rgba(37, 99, 235, 0.2)' : '1px solid var(--t-btn-secondary-border)',
        background: selected ? 'var(--t-accent-soft)' : 'var(--t-bg-card)',
        color: selected ? 'var(--t-text)' : 'var(--t-text-muted)',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      {label}
    </button>
  );
}

export {
  AlertCircle,
  BlueGlassActionButton,
  BlueGlassHoverCard,
  BlueGlassMetricPill,
  BlueGlassSparklineLane,
  FolderOpen,
  FOCUS_REPO_SETUP_EVENT,
  GitBranch,
  GitPullRequest,
  OPEN_REPO_WORKSPACE_EVENT,
  Plus,
  Settings2,
  Trash2,
  orchestratorRuntimeTone,
  orchestratorStatusTone,
  type FocusRepoSetupDetail,
  type OpenRepoWorkspaceDetail,
  type OrchestratorPacket,
  type RepoReadinessState,
  type RepoRegistryEntry,
  type RepoSetupConfig,
  type RepoSetupEnvMode,
  type ValidatedRepoCandidate,
  type WorktreeInfo,
  type WorktreeStatus,
};
