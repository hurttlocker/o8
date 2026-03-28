'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- registry section retains dormant callbacks during workspace tooling rollout */

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  MoreHorizontal,
  Play,
  Plus,
  PlayCircle,
  Settings2,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { BlueGlassActionButton, BlueGlassHoverCard, BlueGlassMetricPill, BlueGlassSparklineLane } from './BlueGlassHoverCard';
import type {
  RepoReadinessState,
  RepoRegistryEntry,
  RepoSetupConfig,
  RepoSetupEnvMode,
  ValidatedRepoCandidate,
} from '@/lib/repos/types';
import { appendOpenClawBetaQuery, readOpenClawBetaEnabled, refreshOpenClawBetaStatus, subscribeOpenClawBetaEnabled } from '@/lib/connectors/openclaw-beta';
import {
  FOCUS_REPO_SETUP_EVENT,
  OPEN_REPO_WORKSPACE_EVENT,
  type FocusRepoSetupDetail,
  type OpenRepoWorkspaceDetail,
} from '@/lib/desktop/events';
import type { WorktreeInfo, WorktreeStatus } from '@/lib/worktree/types';

interface JsonErrorShape {
  error?: string;
}

interface WorkspaceCreateResult {
  id: string;
  branch: string;
  path: string;
  baseBranch: string;
}

interface WorkspaceAgentLaunchRequest {
  repoPath: string;
  runtime?: 'codex' | 'claude-code';
  modelId?: string;
  initialText?: string;
  autoSend?: boolean;
  createNew?: boolean;
  label?: string;
}

interface RepoWorktreeSummary {
  worktrees: WorktreeInfo[];
  conflicts: {
    safe: boolean;
    count: number;
  };
  totalDiskUsage: number;
}

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_ACCENT_SOFT_STRONG = 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.14))';
const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
const THEME_ACCENT_RING = 'var(--t-accent-ring, rgba(37, 99, 235, 0.15))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';
const THEME_SUCCESS_SOFT = 'rgba(34, 197, 94, 0.12)';
const THEME_SUCCESS_BORDER = 'rgba(34, 197, 94, 0.18)';
const THEME_SUCCESS_TEXT = '#4ade80';
const THEME_DANGER_SOFT = 'rgba(239, 68, 68, 0.12)';
const THEME_DANGER_BORDER = 'rgba(239, 68, 68, 0.2)';
const THEME_DANGER_TEXT = '#f87171';
const THEME_WORKTREE_SOFT = 'rgba(245, 158, 11, 0.12)';
const THEME_WORKTREE_SOFT_STRONG = 'rgba(245, 158, 11, 0.18)';
const THEME_WORKTREE_BORDER = 'rgba(245, 158, 11, 0.24)';
const THEME_WORKTREE_TEXT = '#f6b24d';

function formatRelativeTime(value: string | null) {
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

function shortenPath(value: string) {
  const userPath = value.replace(/^\/Users\/[^/]+/, '~');
  if (userPath !== value) return userPath;
  return value.replace(/^\/home\/[^/]+/, '~');
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function worktreeStageTone(status?: WorktreeStatus | null) {
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

function sanitizeWorkspaceName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function getWorkspaceBranchPreview(value: string) {
  const slug = sanitizeWorkspaceName(value) || 'workspace';
  return `worktree/workspace/${slug}`;
}

function githubUrlFromRemote(remoteUrl: string | null) {
  if (!remoteUrl) return null;

  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (httpsMatch?.[1]) return `https://github.com/${httpsMatch[1]}`;

  return null;
}

function githubSlugFromRemote(remoteUrl: string | null) {
  if (!remoteUrl) return null;

  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (httpsMatch?.[1]) return httpsMatch[1];

  return null;
}

function pointWithinRect(rect: DOMRect, x: number, y: number) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function resolveFloatingPanelPosition(anchorRect: DOMRect, width: number) {
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

function defaultWorkspaceName(repoName: string) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `${repoName}-${stamp}`;
}

function normalizeSetupDraft(setup: RepoSetupConfig): RepoSetupConfig {
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

function repoReadinessPalette(state?: RepoReadinessState) {
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

function repoReadinessDisplayLabel(state?: RepoReadinessState, label?: string | null) {
  if (state === 'blocked') return 'Needs attention';
  return label ?? null;
}

function repoReadinessExplanation(readiness?: RepoRegistryEntry['readiness']) {
  if (!readiness) return null;
  return [readiness.summary, readiness.nextAction].filter(Boolean).join(' ');
}

function worktreeStatusExplanation(worktree?: WorktreeInfo | null) {
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

function sortRepoEntries(entries: RepoRegistryEntry[]) {
  return [...entries].sort((a, b) => {
    const aTime = new Date(a.lastOpenedAt ?? a.addedAt).getTime();
    const bTime = new Date(b.lastOpenedAt ?? b.addedAt).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  const data = (await response.json().catch(() => ({}))) as T & JsonErrorShape;
  if (!response.ok) {
    throw new Error(data.error || 'Request failed.');
  }
  return data;
}

function GlassModal({
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
        }}
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

function RepoActionButton({
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
        padding: '8px 10px',
        borderRadius: 10,
        border: `1px solid ${border}`,
        background,
        color,
        fontSize: 11,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        fontFamily: '-apple-system, system-ui, sans-serif',
        transition: 'all 150ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function SetupModeButton({
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
        padding: '8px 10px',
        borderRadius: 10,
        border: selected ? '1px solid rgba(37, 99, 235, 0.2)' : '1px solid var(--t-btn-secondary-border)',
        background: selected ? 'rgba(37, 99, 235, 0.08)' : 'rgba(255, 255, 255, 0.55)',
        color: selected ? 'var(--t-text)' : 'var(--t-text-muted)',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: '-apple-system, system-ui, sans-serif',
      }}
    >
      {label}
    </button>
  );
}

function OverflowDotsIcon({ color = 'currentColor' }: { color?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color,
        fontSize: 18,
        lineHeight: 1,
        fontWeight: 700,
        letterSpacing: '-0.08em',
        transform: 'translateY(-1px)',
      }}
    >
      ...
    </span>
  );
}

interface BranchAgent {
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

interface BranchInfo {
  name: string;
  current: boolean;
  lastCommitAge: string;
  lastCommitMessage: string;
  lastCommitUnix: number;
  isWorktree: boolean;
  worktreePath?: string;
  ahead: number;
  behind: number;
  isStale: boolean;
  staleDays?: number;
  diskSize?: string;
}

interface RepoPreviewPullRequest {
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

interface RepoPreviewPullRequestDetail {
  mergeable: boolean;
  checksStatus: 'success' | 'failure' | 'pending' | 'unknown';
  reviewDecision: string | null;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
}

function mergeRiskLabel(detail: RepoPreviewPullRequestDetail | null): {
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

function compactText(value: string | null | undefined, max = 56) {
  const text = value?.trim() ?? '';
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function normalizeSessionTaskLabel(value?: string | null) {
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

function runtimeBadgeTone(runtime?: string | null) {
  switch (runtime) {
    case 'claude-code':
      return {
        label: 'Claude Code',
        shortLabel: 'CC',
        color: '#8b5cf6',
        background: 'rgba(139, 92, 246, 0.12)',
        border: 'rgba(139, 92, 246, 0.18)',
      };
    case 'openclaw':
      return {
        label: 'OpenClaw',
        shortLabel: 'OC',
        color: '#2563eb',
        background: 'rgba(37, 99, 235, 0.12)',
        border: 'rgba(37, 99, 235, 0.18)',
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

function sessionStatusTone(status?: string | null) {
  switch (status) {
    case 'running':
      return { label: 'Working', color: '#16a34a', glow: 'rgba(22, 163, 74, 0.18)' };
    case 'reviewing':
      return { label: 'Reviewing', color: '#7c3aed', glow: 'rgba(124, 58, 237, 0.18)' };
    case 'waiting':
      return { label: 'Waiting', color: '#d97706', glow: 'rgba(245, 158, 11, 0.18)' };
    case 'blocked':
    case 'failed':
      return { label: 'Blocked', color: '#dc2626', glow: 'rgba(239, 68, 68, 0.18)' };
    default:
      return { label: 'Idle', color: 'var(--t-text-muted)', glow: 'rgba(148, 163, 184, 0.18)' };
  }
}

function sessionSortValue(status?: string | null) {
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

function compareBranchAgents(left: BranchAgent, right: BranchAgent) {
  const statusDelta = sessionSortValue(left.status) - sessionSortValue(right.status);
  if (statusDelta !== 0) return statusDelta;
  return left.sessionKey.localeCompare(right.sessionKey);
}

function branchSessionLabel(agent: BranchAgent) {
  const summary = compactText(normalizeSessionTaskLabel(agent.currentTask), 60);
  if (summary) return summary;
  const runtime = runtimeBadgeTone(agent.runtime).label;
  return compactText(agent.agentName || agent.name || `${runtime} session`, 60) ?? `${runtime} session`;
}

function RepoCard({
  repo,
  workspaceNotice,
  onLaunchAgent,
  onOpenWorkspace,
  onOpenGitHub,
  onRemove,
  onSaveSetup,
  onSelectSession,
  onSelectPR,
  onReviewPR,
  onSelectBranch,
  agentsByBranch,
  activePorts,
  expanded,
  onToggle,
  isActive = false,
  activeSessionKey = null,
  activeWorkspacePath = null,
}: {
  repo: RepoRegistryEntry;
  workspaceNotice: WorkspaceCreateResult | null;
  onLaunchAgent: (repo: RepoRegistryEntry) => void;
  onOpenWorkspace: (repo: RepoRegistryEntry) => void;
  onOpenGitHub: (repo: RepoRegistryEntry) => void;
  onRemove: (repo: RepoRegistryEntry) => void;
  onSaveSetup: (repoId: string, setup: RepoSetupConfig) => Promise<void>;
  onSelectSession?: (sessionKey: string) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onSelectBranch?: (branch: string, repoPath: string) => void;
  agentsByBranch?: Map<string, BranchAgent[]>;
  activePorts?: number[];
  expanded: boolean;
  onToggle: () => void;
  isActive?: boolean;
  activeSessionKey?: string | null;
  activeWorkspacePath?: string | null;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardWidth, setCardWidth] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftSetup, setDraftSetup] = useState<RepoSetupConfig>(repo.setup);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchDeleting, setBranchDeleting] = useState<string | null>(null);
  const [branchDeleteConfirm, setBranchDeleteConfirm] = useState<string | null>(null);
  const [hoveredBranchName, setHoveredBranchName] = useState<string | null>(null);
  const [branchHoverRect, setBranchHoverRect] = useState<DOMRect | null>(null);
  const [sessionDisclosureByBranch, setSessionDisclosureByBranch] = useState<Record<string, boolean>>({});
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchWorktree, setNewBranchWorktree] = useState(false);
  const [newBranchCreating, setNewBranchCreating] = useState(false);
  const [newBranchError, setNewBranchError] = useState<string | null>(null);
  const [devServerRunning, setDevServerRunning] = useState(false);
  const [devServerStarting, setDevServerStarting] = useState(false);
  const [devServerPort, setDevServerPort] = useState<number | null>(null);
  const [devLogsOpen, setDevLogsOpen] = useState(false);
  const [devLogs, setDevLogs] = useState('');
  const [hoveringHeader, setHoveringHeader] = useState(false);
  const [hoverPreviewRect, setHoverPreviewRect] = useState<DOMRect | null>(null);
  const [prPreviewLoading, setPrPreviewLoading] = useState(false);
  const [prPreview, setPrPreview] = useState<RepoPreviewPullRequest[]>([]);
  const [prPreviewLoaded, setPrPreviewLoaded] = useState(false);
  const [prPreviewDetail, setPrPreviewDetail] = useState<RepoPreviewPullRequestDetail | null>(null);
  const [prPreviewDetailLoading, setPrPreviewDetailLoading] = useState(false);
  const [worktreeSummary, setWorktreeSummary] = useState<RepoWorktreeSummary | null>(null);
  const [worktreeSummaryLoading, setWorktreeSummaryLoading] = useState(false);
  const hoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const branchHoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const branchHoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prFetchStartedRef = useRef(false);

  useEffect(() => {
    setDraftSetup(repo.setup);
  }, [repo.setup]);

  useEffect(() => {
    const node = cardRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const updateWidth = () => {
      setCardWidth(node.getBoundingClientRect().width);
    };

    updateWidth();
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (typeof nextWidth === 'number') {
        setCardWidth(nextWidth);
      } else {
        updateWidth();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleFocusRepoSetup = (event: Event) => {
      const detail = (event as CustomEvent<FocusRepoSetupDetail>).detail;
      if (!detail || (detail.repoId !== repo.id && detail.repoPath !== repo.localPath)) {
        return;
      }
      setSettingsOpen(true);
      requestAnimationFrame(() => {
        cardRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    };

    window.addEventListener(FOCUS_REPO_SETUP_EVENT, handleFocusRepoSetup as EventListener);
    return () => {
      window.removeEventListener(FOCUS_REPO_SETUP_EVENT, handleFocusRepoSetup as EventListener);
    };
  }, [repo.id, repo.localPath]);

  // Fetch branches when expanded
  useEffect(() => {
    if (!expanded) return;
    setBranchesLoading(true);
    fetch(`/api/panel/branches?path=${encodeURIComponent(repo.localPath)}`)
      .then(r => r.json())
      .then(data => setBranches(data.branches ?? []))
      .catch(() => setBranches([]))
      .finally(() => setBranchesLoading(false));
  }, [expanded, repo.localPath]);

  // Check dev server status on expand
  useEffect(() => {
    if (!expanded) return;
    fetch('/api/panel/dev-server')
      .then(r => r.json())
      .then((data: { servers?: { id: string; cwd: string; port: number | null; alive: boolean }[] }) => {
        const resolved = repo.localPath.replace(/^~/, process.env.HOME || '');
        const srv = data.servers?.find(s => s.cwd === resolved || s.id === `dev-${repo.localPath}`);
        if (srv?.alive) {
          setDevServerRunning(true);
          setDevServerPort(srv.port);
        } else {
          setDevServerRunning(false);
          setDevServerPort(null);
        }
      })
      .catch(() => {});
  }, [expanded, repo.localPath]);

  // Start dev server
  const handleStartDevServer = useCallback(async () => {
    const cmd = repo.setup.devCommand;
    if (!cmd) return;
    setDevServerStarting(true);
    try {
      const res = await fetch('/api/panel/dev-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: repo.localPath,
          command: cmd,
          port: repo.setup.defaultPort,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setDevServerRunning(true);
        setDevServerPort(data.port);
      }
    } catch { /* silent */ }
    finally { setDevServerStarting(false); }
  }, [repo.localPath, repo.setup.devCommand, repo.setup.defaultPort]);

  // Stop dev server
  const handleStopDevServer = useCallback(async () => {
    try {
      await fetch('/api/panel/dev-server', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath: repo.localPath }),
      });
      setDevServerRunning(false);
      setDevServerPort(null);
    } catch { /* silent */ }
  }, [repo.localPath]);

  // Poll dev server logs when open
  useEffect(() => {
    if (!devLogsOpen || !devServerRunning) return;
    function fetchLogs() {
      fetch('/api/panel/dev-server')
        .then(r => r.json())
        .then((data: { servers?: { id: string; lastOutput: string }[] }) => {
          const srv = data.servers?.find(s => s.id === `dev-${repo.localPath}`);
          if (srv) setDevLogs(srv.lastOutput);
        })
        .catch(() => {});
    }
    fetchLogs();
    const id = setInterval(fetchLogs, 3000);
    return () => clearInterval(id);
  }, [devLogsOpen, devServerRunning, repo.localPath]);

  // ── Branch checkout (#172) ──
  const [checkoutTarget, setCheckoutTarget] = useState<string | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutDirty, setCheckoutDirty] = useState<{ files: string[]; fileCount: number } | null>(null);

  const handleCheckout = useCallback(async (branch: string, opts?: { stash?: boolean; force?: boolean }) => {
    if (branch === branches.find(b => b.current)?.name) return; // Already on this branch
    setCheckoutBusy(true);
    setCheckoutDirty(null);
    try {
      const res = await fetch('/api/panel/branches/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: repo.localPath,
          branch,
          stash: opts?.stash,
          force: opts?.force,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.dirty) {
        setCheckoutTarget(branch);
        setCheckoutDirty({ files: data.files, fileCount: data.fileCount });
        return;
      }
      if (res.ok) {
        // Refresh branches to show new current
        fetch(`/api/panel/branches?path=${encodeURIComponent(repo.localPath)}`)
          .then(r => r.json())
          .then(d => setBranches(d.branches ?? []))
          .catch(() => {});
        setCheckoutTarget(null);
      }
    } catch { /* silent */ }
    finally { setCheckoutBusy(false); }
  }, [branches, repo.localPath]);

  // Refresh branches
  const refreshBranches = useCallback(() => {
    fetch(`/api/panel/branches?path=${encodeURIComponent(repo.localPath)}`)
      .then(r => r.json())
      .then(data => setBranches(data.branches ?? []))
      .catch(() => {});
  }, [repo.localPath]);

  const refreshWorktreeSummary = useCallback(async () => {
    setWorktreeSummaryLoading(true);
    try {
      const data = await requestJson<RepoWorktreeSummary>(`/api/worktrees?repo=${encodeURIComponent(repo.localPath)}`);
      setWorktreeSummary(data);
    } catch {
      setWorktreeSummary(null);
    } finally {
      setWorktreeSummaryLoading(false);
    }
  }, [repo.localPath]);

  const staleWorktrees = useMemo(
    () => (worktreeSummary?.worktrees ?? []).filter((worktree) => worktree.status === 'stale'),
    [worktreeSummary],
  );

  const handleCleanupWorktree = useCallback(async (worktree: WorktreeInfo) => {
    const confirmed = window.confirm(
      `Clean up ${worktree.branch}?\n\nThis removes the workspace directory and deletes the branch if possible.`,
    );
    if (!confirmed) return;

    try {
      await requestJson('/api/worktrees', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: repo.localPath,
          action: 'cleanup',
          worktreeId: worktree.id,
          force: worktree.status === 'stale',
          deleteBranch: true,
        }),
      });
      refreshBranches();
      await refreshWorktreeSummary();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : `Unable to clean up ${worktree.branch}.`);
    }
  }, [refreshBranches, refreshWorktreeSummary, repo.localPath]);

  const handlePruneStaleWorktrees = useCallback(async () => {
    if (staleWorktrees.length === 0) return;
    const confirmed = window.confirm(
      `Prune ${staleWorktrees.length} stale workspace${staleWorktrees.length === 1 ? '' : 's'} for ${repo.name}?\n\nThis removes the stale worktree directories and their branches.`,
    );
    if (!confirmed) return;

    try {
      await requestJson('/api/worktrees', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: repo.localPath,
          action: 'prune',
        }),
      });
      refreshBranches();
      await refreshWorktreeSummary();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to prune stale workspaces.');
    }
  }, [refreshBranches, refreshWorktreeSummary, repo.localPath, repo.name, staleWorktrees.length]);

  // Delete branch handler
  const handleDeleteBranch = useCallback(async (branchName: string, force?: boolean) => {
    setBranchDeleting(branchName);
    try {
      const res = await fetch('/api/panel/branches', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repo.localPath, branch: branchName, force }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.canForce) {
          setBranchDeleteConfirm(branchName);
        }
        return;
      }
      setBranchDeleteConfirm(null);
      setHoveredBranchName(null);
      setBranchHoverRect(null);
      refreshBranches();
      void refreshWorktreeSummary();
    } catch { /* silent */ }
    finally { setBranchDeleting(null); }
  }, [refreshBranches, refreshWorktreeSummary, repo.localPath]);

  // Create branch handler
  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setNewBranchCreating(true);
    setNewBranchError(null);
    try {
      const res = await fetch('/api/panel/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: repo.localPath,
          branch: name,
          baseBranch: repo.defaultBranch,
          worktree: newBranchWorktree,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNewBranchError(data.error ?? 'Failed to create branch');
        return;
      }
      setNewBranchName('');
      setCreateBranchOpen(false);
      setNewBranchWorktree(false);
      refreshBranches();
      if (newBranchWorktree) {
        void refreshWorktreeSummary();
      }
    } catch (err) {
      setNewBranchError(err instanceof Error ? err.message : 'Failed');
    } finally { setNewBranchCreating(false); }
  }, [newBranchName, newBranchWorktree, refreshBranches, refreshWorktreeSummary, repo.localPath, repo.defaultBranch]);

  const githubUrl = useMemo(() => githubUrlFromRemote(repo.remoteUrl), [repo.remoteUrl]);
  const githubSlug = useMemo(() => githubSlugFromRemote(repo.remoteUrl), [repo.remoteUrl]);
  const hasUnsavedChanges = JSON.stringify(draftSetup) !== JSON.stringify(repo.setup);

  useEffect(() => {
    if (!hoveringHeader || !githubSlug || prPreviewLoaded || prFetchStartedRef.current) return;
    prFetchStartedRef.current = true;
    const controller = new AbortController();
    const abortTimeoutId = setTimeout(() => controller.abort(), 3_000);
    let active = true;
    // Delay showing loading indicator by 500ms — prevents flash-of-loading
    // for fast responses and for repos with no open PRs
    const loadingDelayId = setTimeout(() => {
      if (active) setPrPreviewLoading(true);
    }, 500);
    fetch(`/api/panel/prs?repo=${encodeURIComponent(githubSlug)}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((data) => {
        if (!active) return;
        setPrPreview((data.prs ?? []).filter((pr: RepoPreviewPullRequest) => pr.state === 'OPEN'));
        setPrPreviewLoaded(true);
      })
      .catch(() => {
        if (active) {
          setPrPreview([]);
          setPrPreviewLoaded(true);
        }
      })
      .finally(() => {
        clearTimeout(abortTimeoutId);
        clearTimeout(loadingDelayId);
        if (active) setPrPreviewLoading(false);
      });
    return () => {
      active = false;
      clearTimeout(abortTimeoutId);
      clearTimeout(loadingDelayId);
      controller.abort();
    };
  }, [githubSlug, hoveringHeader, prPreviewLoaded]);

  useEffect(() => {
    return () => {
      if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
      if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
      if (branchHoverOpenTimerRef.current) clearTimeout(branchHoverOpenTimerRef.current);
      if (branchHoverCloseTimerRef.current) clearTimeout(branchHoverCloseTimerRef.current);
    };
  }, []);

  const schedulePreviewHover = useCallback((element: HTMLDivElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    if (!pointWithinRect(rect, clientX, clientY)) return;

    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = setTimeout(() => {
      setHoverPreviewRect(rect);
      setHoveringHeader(true);
      hoverOpenTimerRef.current = null;
    }, 120);
  }, []);

  const closePreviewHover = useCallback(() => {
    if (hoverOpenTimerRef.current) {
      clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = setTimeout(() => {
      setHoveringHeader(false);
      setHoverPreviewRect(null);
    }, 140);
  }, []);

  const scheduleBranchHover = useCallback((branchName: string, element: HTMLDivElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    if (!pointWithinRect(rect, clientX, clientY)) return;

    if (branchHoverCloseTimerRef.current) {
      clearTimeout(branchHoverCloseTimerRef.current);
      branchHoverCloseTimerRef.current = null;
    }
    if (branchHoverOpenTimerRef.current) clearTimeout(branchHoverOpenTimerRef.current);
    branchHoverOpenTimerRef.current = setTimeout(() => {
      setHoveredBranchName(branchName);
      setBranchHoverRect(rect);
      branchHoverOpenTimerRef.current = null;
    }, 90);
  }, []);

  const holdBranchHover = useCallback(() => {
    if (branchHoverCloseTimerRef.current) {
      clearTimeout(branchHoverCloseTimerRef.current);
      branchHoverCloseTimerRef.current = null;
    }
  }, []);

  const closeBranchHover = useCallback(() => {
    if (branchHoverOpenTimerRef.current) {
      clearTimeout(branchHoverOpenTimerRef.current);
      branchHoverOpenTimerRef.current = null;
    }
    if (branchHoverCloseTimerRef.current) clearTimeout(branchHoverCloseTimerRef.current);
    branchHoverCloseTimerRef.current = setTimeout(() => {
      setHoveredBranchName(null);
      setBranchHoverRect(null);
    }, 120);
  }, []);

  const previewCheckCounts = useMemo(() => {
    const checks = prPreview[0]?.statusCheckRollup ?? [];
    return {
      passed: checks.filter((check) => check.conclusion?.toLowerCase() === 'success').length,
      failed: checks.filter((check) => check.conclusion?.toLowerCase() === 'failure').length,
      pending: checks.filter((check) => !check.conclusion || check.status?.toLowerCase() !== 'completed').length,
    };
  }, [prPreview]);
  const previewFailingChecks = useMemo(
    () => (prPreview[0]?.statusCheckRollup ?? [])
      .filter((check) => check.conclusion?.toLowerCase() === 'failure')
      .map((check) => check.name || 'Unknown check')
      .slice(0, 3),
    [prPreview],
  );
  const mergeRisk = useMemo(() => mergeRiskLabel(prPreviewDetail), [prPreviewDetail]);

  useEffect(() => {
    if (!expanded) return;
    void refreshWorktreeSummary();
  }, [expanded, refreshWorktreeSummary]);

  useEffect(() => {
    if (!expanded || !workspaceNotice) return;
    void refreshWorktreeSummary();
  }, [expanded, refreshWorktreeSummary, workspaceNotice]);

  const worktreesByBranch = useMemo(
    () => new Map((worktreeSummary?.worktrees ?? []).map((worktree) => [worktree.branch, worktree])),
    [worktreeSummary],
  );
  const worktreeHealthBanner = useMemo(() => {
    if (worktreeSummaryLoading) {
      return {
        tone: worktreeStageTone('setup'),
        title: 'Checking workspace health',
        detail: 'Refreshing isolated workspace status for this repo.',
      };
    }
    if (worktreeSummary && worktreeSummary.conflicts.count > 0) {
      return {
        tone: worktreeStageTone('stale'),
        title: 'Blocked',
        detail: `${worktreeSummary.conflicts.count} overlapping worktree file${worktreeSummary.conflicts.count === 1 ? '' : 's'} need operator attention before stacking more work.`,
      };
    }
    if (staleWorktrees.length > 0) {
      return {
        tone: worktreeStageTone('cleaning'),
        title: 'Waiting',
        detail: `${staleWorktrees.length} stale workspace${staleWorktrees.length === 1 ? '' : 's'} can be cleaned up now. ${worktreeSummary ? `${worktreeSummary.worktrees.length} tracked · ${formatBytes(worktreeSummary.totalDiskUsage)}.` : ''}`,
      };
    }
    return null;
  }, [staleWorktrees.length, worktreeSummary, worktreeSummaryLoading]);

  useEffect(() => {
    if (!githubSlug || !prPreview[0]?.number || prPreviewDetail || prPreviewDetailLoading) return;
    let active = true;
    setPrPreviewDetailLoading(true);
    fetch(`/api/panel/pr?repo=${encodeURIComponent(githubSlug)}&number=${prPreview[0].number}`)
      .then((response) => response.json())
      .then((detail) => {
        if (!active || detail?.error) return;
        setPrPreviewDetail({
          mergeable: Boolean(detail.mergeable),
          checksStatus: detail.checksStatus ?? 'unknown',
          reviewDecision: detail.reviewDecision ?? null,
          files: detail.files ?? [],
        });
      })
      .catch(() => {
        if (active) setPrPreviewDetail(null);
      })
      .finally(() => {
        if (active) setPrPreviewDetailLoading(false);
      });
    return () => { active = false; };
  }, [githubSlug, prPreview, prPreviewDetail, prPreviewDetailLoading]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSaveSetup(repo.id, normalizeSetupDraft(draftSetup));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Unable to save setup profile.');
    } finally {
      setSaving(false);
    }
  }, [draftSetup, onSaveSetup, repo.id]);

  const updateEnvMode = useCallback((envMode: RepoSetupEnvMode) => {
    setDraftSetup((current) => ({
      ...current,
      envMode,
    }));
  }, []);

  const handleOpenDesktopPath = useCallback(async (editor: 'finder' | 'terminal', targetPath: string) => {
    try {
      await requestJson('/api/panel/open-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editor, repo: targetPath }),
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : `Unable to open ${shortenPath(targetPath)}.`);
    }
  }, []);

  const handleCopyPath = useCallback(async (targetPath: string, label: string) => {
    try {
      await navigator.clipboard.writeText(targetPath);
    } catch {
      window.alert(`Unable to copy the ${label}.`);
    }
  }, []);

  const cardBackground = 'transparent';
  const compactLayout = cardWidth > 0 && cardWidth < 320;
  const repoAgents = useMemo(() => {
    const unique = new Map<string, BranchAgent>();
    agentsByBranch?.forEach((branchAgents) => {
      branchAgents.forEach((agent) => {
        if (!unique.has(agent.sessionKey)) {
          unique.set(agent.sessionKey, agent);
        }
      });
    });
    return Array.from(unique.values());
  }, [agentsByBranch]);

  const activeWorktree = useMemo(
    () => (worktreeSummary?.worktrees ?? []).find((worktree) => worktree.path === activeWorkspacePath) ?? null,
    [activeWorkspacePath, worktreeSummary],
  );
  const activeWorktreeTone = activeWorktree ? worktreeStageTone(activeWorktree.status) : null;
  const readinessPalette = repo.readiness ? repoReadinessPalette(repo.readiness.state) : null;
  const readinessDisplayLabel = repoReadinessDisplayLabel(repo.readiness?.state, repo.readiness?.label);
  const readinessExplanation = repoReadinessExplanation(repo.readiness);
  const activeWorktreeExplanation = worktreeStatusExplanation(activeWorktree);
  const rowStatusLabel = activeWorktreeTone?.label ?? readinessDisplayLabel ?? null;
  const rowStatusColor = activeWorktreeTone?.color ?? readinessPalette?.color ?? 'var(--t-text-faint)';
  const rowStatusExplanation = activeWorktreeExplanation ?? readinessExplanation;
  const showStatusInfo = Boolean(
    rowStatusLabel
    && rowStatusExplanation
    && (activeWorktreeTone?.label || repo.readiness?.state === 'blocked' || repo.readiness?.state === 'needs_setup'),
  );
  const currentBadge = isActive && !activeWorktree ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: compactLayout ? '2px 8px' : '3px 9px',
        borderRadius: 999,
        background: THEME_ACCENT_SOFT,
        border: `1px solid ${THEME_ACCENT_BORDER}`,
        color: THEME_ACCENT,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
    >
      Current
    </span>
  ) : null;
  const showInlineRepoMeta = false;
  const portsBadge = activePorts && activePorts.length > 0 ? (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: compactLayout ? '1px 5px' : '1px 6px',
      borderRadius: 999,
      background: THEME_SUCCESS_SOFT,
      border: `1px solid ${THEME_SUCCESS_BORDER}`,
      flexShrink: 0,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: THEME_SUCCESS_TEXT,
      }} />
      <span style={{
        fontSize: 10, fontWeight: 600, color: THEME_SUCCESS_TEXT,
        fontFamily: '"SF Mono", ui-monospace, monospace',
      }}>
        {activePorts.length === 1 ? `:${activePorts[0]}` : `${activePorts.length} ports`}
      </span>
    </span>
  ) : null;
  const prBadge = prPreview.length > 0 ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: compactLayout ? '2px 7px' : '2px 8px',
        borderRadius: 999,
        background: THEME_ACCENT_SOFT,
        border: `1px solid ${THEME_ACCENT_BORDER}`,
        flexShrink: 0,
      }}
    >
      <GitPullRequest size={10} strokeWidth={2.2} color="currentColor" />
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: THEME_ACCENT,
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}
      >
        PR #{prPreview[0].number}
      </span>
    </span>
  ) : null;
  const mergeRiskBadge = prPreview.length > 0 ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        background: `${mergeRisk.color}14`,
        border: `1px solid ${mergeRisk.color}28`,
        color: mergeRisk.color,
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        flexShrink: 0,
      }}
    >
      {mergeRisk.label}
    </span>
  ) : null;
  const readinessBadge = repo.readiness ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: compactLayout ? '2px 7px' : '2px 8px',
        borderRadius: 999,
        background: readinessPalette?.background,
        border: `1px solid ${readinessPalette?.border}`,
        color: readinessPalette?.color,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
      title={readinessExplanation ?? repo.readiness.summary}
    >
      {readinessDisplayLabel}
      {readinessExplanation && repo.readiness.state !== 'ready' ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'help',
          }}
          title={readinessExplanation}
          aria-label={readinessExplanation}
        >
          <AlertCircle size={11} strokeWidth={2.1} />
        </span>
      ) : null}
    </span>
  ) : null;
  const branchBadge = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: compactLayout ? '1px 5px' : '1px 6px',
        borderRadius: 999,
        background: 'var(--t-divider-subtle)',
        color: 'var(--t-text-secondary)',
        fontSize: 10,
        fontWeight: 600,
        fontFamily: '"SF Mono", ui-monospace, monospace',
        flexShrink: 0,
      }}
    >
      <GitBranch size={10} strokeWidth={2} />
      {repo.defaultBranch}
    </span>
  );
  const repoAgentsBadge = repoAgents.length > 0 ? (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: compactLayout ? '2px 7px' : '2px 8px',
        borderRadius: 999,
        background: 'var(--t-panel-hover)',
        border: '1px solid var(--t-panel-border)',
        color: 'var(--t-text-secondary)',
        fontSize: 10,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: '#34c759',
          boxShadow: '0 0 8px rgba(52, 199, 89, 0.32)',
        }}
      />
      {repoAgents.length} live
    </span>
  ) : null;
  const headerMetaBadges = [
    currentBadge,
    readinessBadge,
    portsBadge,
    branchBadge,
    repoAgentsBadge,
    prBadge,
    mergeRiskBadge,
  ].filter(Boolean);
  const primaryPreview = prPreview[0] ?? null;
  const rowMetaSegments: Array<{ key: string; content: React.ReactNode }> = [
    {
      key: 'branch',
      content: (
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {activeWorktree?.branch ?? repo.defaultBranch}
        </span>
      ),
    },
  ];
  if (rowStatusLabel) {
    rowMetaSegments.push({
      key: 'status',
      content: (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            minWidth: 0,
            color: rowStatusColor,
            fontWeight: 600,
          }}
          title={rowStatusExplanation ?? undefined}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {rowStatusLabel}
          </span>
          {showStatusInfo ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                cursor: 'help',
              }}
              title={rowStatusExplanation ?? undefined}
              aria-label={rowStatusExplanation ?? undefined}
            >
              <AlertCircle size={10} strokeWidth={2.1} />
            </span>
          ) : null}
        </span>
      ),
    });
  }
  if (primaryPreview) {
    rowMetaSegments.push({
      key: 'pr',
      content: <span>{`PR #${primaryPreview.number}`}</span>,
    });
  }
  if (repoAgents.length > 0) {
    rowMetaSegments.push({
      key: 'live',
      content: <span>{`${repoAgents.length} live`}</span>,
    });
  }
  rowMetaSegments.splice(3);
  const repoHeaderLeadingInset = 19;
  const visibleBranches = useMemo(
    () => branches.filter((branch) => branch.isWorktree || !branch.current || Boolean(agentsByBranch?.get(branch.name)?.length)),
    [agentsByBranch, branches],
  );
  const showHeaderHover = hoveringHeader && (
    prPreviewLoading
    || prPreview.length > 0
    || headerMetaBadges.length > 0
    || Boolean(repo.readiness?.summary)
  );
  const menuTrigger = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        setMenuRect(rect);
        setMenuOpen((v) => !v);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: 8,
        border: menuOpen ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)',
        background: menuOpen
          ? THEME_ACCENT_SOFT
          : THEME_BG_CARD,
        color: menuOpen ? THEME_ACCENT : 'var(--t-text-secondary)',
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'all 140ms ease',
      }}
      onMouseEnter={(e) => {
        const target = e.currentTarget;
        if (!menuOpen) {
          target.style.background = THEME_ACCENT_SOFT;
          target.style.borderColor = THEME_ACCENT_BORDER;
          target.style.color = THEME_ACCENT;
        }
      }}
      onMouseLeave={(e) => {
        const target = e.currentTarget;
        if (!menuOpen) {
          target.style.background = THEME_BG_CARD;
          target.style.borderColor = 'var(--t-panel-border)';
          target.style.color = 'var(--t-text-secondary)';
        }
      }}
      aria-label={`Open actions for ${repo.name}`}
    >
      <OverflowDotsIcon color="currentColor" />
    </button>
  );

  return (
    <div
      ref={cardRef}
        style={{
          position: 'relative',
          borderRadius: 0,
          background: cardBackground,
        borderTopWidth: 0,
        borderRightWidth: 0,
        borderBottomWidth: 1,
        borderLeftWidth: 0,
        borderTopStyle: 'solid',
        borderRightStyle: 'solid',
        borderBottomStyle: 'solid',
        borderLeftStyle: 'solid',
        borderTopColor: 'transparent',
        borderRightColor: 'transparent',
        borderBottomColor: 'var(--t-divider-subtle)',
        borderLeftColor: 'transparent',
        overflow: 'hidden',
      }}
    >
      {/* Compact header row — Conductor style */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: compactLayout ? '9px 14px 8px' : '10px 14px 9px',
          cursor: 'pointer',
        }}
        onClick={onToggle}
        onMouseEnter={(event) => schedulePreviewHover(event.currentTarget as HTMLDivElement, event.clientX, event.clientY)}
        onMouseLeave={closePreviewHover}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            minWidth: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0, paddingLeft: repoHeaderLeadingInset }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: 'var(--t-text)',
                  letterSpacing: '-0.01em',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {repo.name}
              </span>
              {isActive ? currentBadge : null}
            </div>
            <div
              style={{
                marginTop: 2,
                fontSize: 10,
                lineHeight: 1.3,
                color: 'var(--t-text-faint)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {rowMetaSegments.length > 0 ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0,
                    minWidth: 0,
                    maxWidth: '100%',
                  }}
                >
                  {rowMetaSegments.map((segment, index) => (
                    <span
                      key={segment.key}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        minWidth: 0,
                      }}
                    >
                      {index > 0 ? (
                        <span style={{ padding: '0 5px', color: 'var(--t-text-faint)' }}>·</span>
                      ) : null}
                      {segment.content}
                    </span>
                  ))}
                </span>
              ) : shortenPath(repo.localPath)}
            </div>
          </div>
          {menuTrigger}
        </div>
      </div>

      {showHeaderHover ? (
        <BlueGlassHoverCard
          eyebrow={prPreviewLoading || prPreview.length > 0 ? 'Repository Status' : 'Repository'}
          title={prPreviewLoading ? `Checking ${repo.name}…` : repo.name}
          subtitle={prPreviewLoading
            ? 'Looking for active merge work and repo status.'
            : shortenPath(repo.localPath)}
          anchorRect={hoverPreviewRect}
          interactive
          onMouseEnter={() => {
            if (hoverCloseTimerRef.current) {
              clearTimeout(hoverCloseTimerRef.current);
              hoverCloseTimerRef.current = null;
            }
          }}
          onMouseLeave={closePreviewHover}
          footer={prPreviewLoading ? null : (
            <>
              {prPreview.length > 0 ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <BlueGlassMetricPill label="Review" value={primaryPreview?.reviewDecision || 'pending'} color="#1d4ed8" />
                  <BlueGlassMetricPill
                    label="Files"
                    value={String(primaryPreview?.changedFiles ?? 0)}
                    color="rgba(15,23,42,0.78)"
                  />
                  <BlueGlassMetricPill label="Risk" value={mergeRisk.label} color={mergeRisk.color} />
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {primaryPreview && onReviewPR ? (
                  <BlueGlassActionButton
                    icon={<GitPullRequest size={12} strokeWidth={2} />}
                    label="Review"
                    onClick={() => onReviewPR(primaryPreview.number, githubSlug ?? undefined)}
                  />
                ) : null}
                {primaryPreview && onSelectPR ? (
                  <BlueGlassActionButton
                    icon={<ArrowRight size={12} strokeWidth={2} />}
                    label="Open full PR"
                    onClick={() => onSelectPR(primaryPreview.number, githubSlug ?? undefined)}
                  />
                ) : null}
                {primaryPreview?.url ? (
                  <BlueGlassActionButton
                    icon={<ExternalLink size={12} strokeWidth={2} />}
                    label="Open on GitHub"
                    onClick={() => window.open(primaryPreview.url, '_blank', 'noopener,noreferrer')}
                  />
                ) : null}
              </div>
            </>
          )}
        >
          {!prPreviewLoading ? (
            <>
              {headerMetaBadges.length > 0 ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {headerMetaBadges.map((badge, index) => (
                    <span key={index}>{badge}</span>
                  ))}
                </div>
              ) : null}
              {repo.readiness?.summary ? (
                <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(15, 23, 42, 0.76)' }}>
                  {repo.readiness.summary}
                </div>
              ) : null}
              {prPreview.length > 0 ? (
                <>
                  <BlueGlassSparklineLane
                    segments={[
                      { label: 'Pass', value: previewCheckCounts.passed, color: '#22c55e' },
                      { label: 'Fail', value: previewCheckCounts.failed, color: '#ef4444' },
                      { label: 'Pending', value: previewCheckCounts.pending, color: '#f59e0b' },
                    ]}
                  />
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      fontSize: 11,
                      color: 'rgba(15, 23, 42, 0.7)',
                    }}
                  >
                    <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace' }}>{primaryPreview?.headRefName}</span>
                    <span>{primaryPreview ? formatRelativeTime(primaryPreview.createdAt) : null}</span>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.5, color: 'rgba(15, 23, 42, 0.76)' }}>
                    {primaryPreview?.title}
                  </div>
                  {previewFailingChecks.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#dc2626' }}>
                        Top failing checks
                      </div>
                      {previewFailingChecks.map((check) => (
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
                  {prPreviewDetail?.files?.length ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#1d4ed8' }}>
                        Changed files
                      </div>
                      {prPreviewDetail.files.slice(0, 3).map((file) => (
                        <div
                          key={file.path}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 8px',
                            borderRadius: 10,
                            background: 'var(--t-panel-hover)',
                            fontSize: 11,
                          }}
                        >
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text)' }}>
                            {file.path}
                          </span>
                          <span style={{ color: 'var(--t-text-secondary)', fontWeight: 700, fontFamily: '"SF Mono", ui-monospace, monospace' }}>+{file.additions}</span>
                          <span style={{ color: 'var(--t-text-secondary)', fontWeight: 700, fontFamily: '"SF Mono", ui-monospace, monospace' }}>-{file.deletions}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {prPreview.length > 1 ? (
                    <div style={{ fontSize: 11, color: 'rgba(15, 23, 42, 0.62)' }}>
                      {prPreview.length - 1} more open PR{prPreview.length - 1 === 1 ? '' : 's'} on this repo.
                    </div>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </BlueGlassHoverCard>
      ) : null}

      {/* Overflow menu dropdown */}
      {menuOpen && menuRect && typeof document !== 'undefined' ? createPortal(
        <>
          <div
            onClick={() => setMenuOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9997,
            }}
          />
          <div
            style={{
              position: 'fixed',
              top: Math.round(menuRect.bottom + 8),
              left: Math.round(menuRect.right - 184),
              zIndex: 9998,
              minWidth: 184,
              padding: '6px 0',
              borderRadius: 14,
              border: '1px solid var(--t-panel-border)',
              background: THEME_PANEL_GLASS,
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              boxShadow: 'var(--t-panel-shadow)',
            }}
          >
            {[
              ...(githubUrl ? [{ label: 'Open on GitHub', icon: <ExternalLink size={12} strokeWidth={2} />, action: () => { onOpenGitHub(repo); setMenuOpen(false); } }] : []),
              { label: 'Open folder', icon: <FolderOpen size={12} strokeWidth={2} />, action: () => { void handleOpenDesktopPath('finder', repo.localPath); setMenuOpen(false); } },
              { label: 'Copy repo path', icon: <Copy size={12} strokeWidth={2} />, action: () => { void handleCopyPath(repo.localPath, 'repo path'); setMenuOpen(false); } },
              { label: 'Remove from Cortex', icon: <Trash2 size={12} strokeWidth={2} />, action: () => { onRemove(repo); setMenuOpen(false); }, danger: true },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={item.action}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '9px 14px',
                  border: 'none',
                  background: 'transparent',
                  color: (item as { danger?: boolean }).danger ? '#ef4444' : 'var(--t-text)',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  textAlign: 'left',
                }}
              >
                <span style={{ color: (item as { danger?: boolean }).danger ? '#ef4444' : 'var(--t-text-muted)', display: 'flex' }}>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      ) : null}

      {/* Expanded content */}
      {expanded ? (
        <div style={{ padding: compactLayout ? '6px 14px 12px 14px' : '4px 14px 14px 14px' }}>
          {/* Multi-agent conflict warning */}
          {showInlineRepoMeta ? (() => {
            if (!agentsByBranch) return null;
            const conflicts: { branch: string; agents: BranchAgent[] }[] = [];
            agentsByBranch.forEach((agents, branch) => {
              if (agents.length > 1) conflicts.push({ branch, agents });
            });
            if (conflicts.length === 0) return null;
            return (
              <div style={{
                margin: '4px 0',
                padding: '8px 10px',
                borderRadius: 10,
                background: THEME_DANGER_SOFT,
                border: `1px solid ${THEME_DANGER_BORDER}`,
              }}>
                {conflicts.map((c) => (
                  <div key={c.branch} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 10.5,
                    color: 'var(--t-text)',
                    fontWeight: 600,
                  }}>
                    <AlertCircle size={11} strokeWidth={2} style={{ color: THEME_DANGER_TEXT, flexShrink: 0 }} />
                    <span>
                      {c.agents.map(a => a.name).join(' + ')} both on <span style={{
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        color: THEME_DANGER_TEXT,
                        padding: '1px 5px',
                        borderRadius: 999,
                      }}>{c.branch}</span>
                    </span>
                  </div>
                ))}
              </div>
            );
          })() : null}

          {/* Dev server logs */}
          {devLogsOpen && devServerRunning ? (
            <div style={{
              margin: '4px 0',
              borderRadius: 8,
              border: '1px solid var(--t-panel-border)',
              background: '#0f172a',
              overflow: 'hidden',
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 8px',
                background: 'rgba(255,255,255,0.03)',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}>
                <span style={{ fontSize: 9, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Dev Server Output
                </span>
                <span style={{ fontSize: 9, color: '#475569' }}>
                  {repo.setup.devCommand}
                </span>
              </div>
              <pre style={{
                margin: 0,
                padding: 8,
                fontSize: 10,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                color: '#e2e8f0',
                lineHeight: 1.5,
                maxHeight: 140,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
                {devLogs || 'Waiting for output…'}
              </pre>
            </div>
          ) : null}

          {/* Workspace notice */}
          {showInlineRepoMeta && workspaceNotice ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 0',
                fontSize: 12,
                color: 'var(--t-text)',
              }}
            >
              <GitBranch size={12} strokeWidth={2} style={{ color: '#15803d', flexShrink: 0 }} />
              <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontWeight: 500 }}>
                {workspaceNotice.branch}
              </span>
              <span style={{ fontSize: 10, color: '#15803d', fontWeight: 600 }}>Workspace ready</span>
            </div>
          ) : null}

          {showInlineRepoMeta && repo.readiness ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                marginBottom: 8,
                padding: '10px 12px',
                borderRadius: 12,
                border: `1px solid ${readinessPalette?.border}`,
                background: readinessPalette?.background,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: readinessPalette?.color,
                  }}
                >
                  {readinessDisplayLabel}
                </span>
                {repo.readiness.currentBranch ? (
                  <span style={{
                    fontSize: 11,
                    color: 'var(--t-text)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    padding: '2px 6px',
                    borderRadius: 999,
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}>
                    {repo.readiness.currentBranch}
                  </span>
                ) : null}
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text)' }}>
                {repo.readiness.summary}
              </div>
              {repo.readiness.nextAction ? (
                <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-secondary)' }}>
                  {repo.readiness.nextAction}
                </div>
              ) : null}
              {repo.readiness.state !== 'ready' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(true)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      color: readinessPalette?.color,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                    }}
                  >
                    <Settings2 size={11} strokeWidth={2} />
                    Open setup
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenWorkspace(repo)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--t-text-secondary)',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                    }}
                  >
                    <GitBranch size={11} strokeWidth={2} />
                    Create workspace anyway
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {showInlineRepoMeta && worktreeHealthBanner ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                marginBottom: 8,
                padding: '10px 12px',
                borderRadius: 12,
                border: `1px solid ${worktreeHealthBanner.tone.border}`,
                background: worktreeHealthBanner.tone.background,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: worktreeHealthBanner.tone.color,
                  }}
                >
                  {worktreeHealthBanner.title}
                </span>
                {worktreeSummary && worktreeSummary.worktrees.length > 0 ? (
                  <span style={{ fontSize: 11, color: 'var(--t-text-secondary)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                    {worktreeSummary.worktrees.length} tracked
                  </span>
                ) : null}
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--t-text)' }}>
                {worktreeHealthBanner.detail}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {staleWorktrees.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => { void handlePruneStaleWorktrees(); }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      color: worktreeHealthBanner.tone.color,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                    }}
                  >
                    <Trash2 size={11} strokeWidth={2} />
                    Clean stale workspaces
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => { void handleOpenDesktopPath('finder', repo.localPath); }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--t-text-secondary)',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}
                >
                  <FolderOpen size={11} strokeWidth={2} />
                  Open repo
                </button>
                <button
                  type="button"
                  onClick={() => { void handleCopyPath(repo.localPath, 'repo path'); }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--t-text-secondary)',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}
                >
                  <ExternalLink size={11} strokeWidth={2} />
                  Copy path
                </button>
              </div>
            </div>
          ) : null}

          {/* Branch list — Apple-grade progressive disclosure */}
          <div style={{ marginTop: 6 }}>
            {branchesLoading ? (
              <div style={{ fontSize: 11, color: 'var(--t-text-faint)', padding: '4px 0' }}>Loading branches…</div>
            ) : visibleBranches.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {visibleBranches.map((branch) => {
                  const branchAgents = agentsByBranch?.get(branch.name) ?? [];
                  const orderedBranchAgents = [...branchAgents].sort(compareBranchAgents);
                  const sessionsExpanded = sessionDisclosureByBranch[branch.name] ?? true;
                  const isIdleWorktree = branch.isWorktree && branch.isStale;
                  const isCurrentBranch = branch.current;
                  const worktree = worktreesByBranch.get(branch.name);
                  const isActiveWorktree = Boolean(activeWorkspacePath && worktree?.path === activeWorkspacePath);
                  const isActiveRootBranch = Boolean(!branch.isWorktree && branch.current && activeWorkspacePath === repo.localPath);
                  const isActiveScope = isActiveWorktree || isActiveRootBranch;
                  const worktreeTone = branch.isWorktree
                    ? worktreeStageTone(worktree?.status ?? (branch.isStale ? 'stale' : 'ready'))
                    : null;
                  const canOpenPr = Boolean(
                    githubUrl
                    && !branch.current
                    && branch.name !== repo.defaultBranch
                    && branch.ahead > 0,
                  );
                  const branchAgentLabel = branchAgents.length === 1
                    ? branchAgents[0]?.name ?? null
                    : branchAgents.length > 1
                      ? `${branchAgents.length} agents`
                      : null;
                  const branchDiffAgent = branchAgents.find((agent) => ((agent.additions ?? 0) > 0 || (agent.deletions ?? 0) > 0)) ?? null;
                  const branchBaseBackground = isActiveScope ? 'rgba(37, 99, 235, 0.08)' : 'transparent';
                  const branchHoverBackground = 'var(--t-panel-hover)';
                  return (
                  <div key={branch.name}>
                  <div
                    onClick={() => {
                      if (!branch.current && !checkoutBusy) {
                        handleCheckout(branch.name);
                      }
                    }}
                    onMouseEnter={(e) => {
                      const target = e.currentTarget as HTMLDivElement;
                      target.style.background = branchHoverBackground;
                      scheduleBranchHover(branch.name, target, e.clientX, e.clientY);
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = branchBaseBackground;
                      closeBranchHover();
                    }}
                  style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      minHeight: branch.isWorktree ? 40 : 32,
                      padding: '6px 7px',
                      borderRadius: 8,
                      background: branchBaseBackground,
                      border: isActiveScope ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid transparent',
                      cursor: branch.current ? 'default' : checkoutBusy ? 'wait' : 'pointer',
                      transition: 'background 120ms ease, border-color 120ms ease',
                    }}
                  >
                    {/* Branch icon — colored by type */}
                    <GitBranch
                      size={11}
                      strokeWidth={2}
                      style={{
                        flexShrink: 0,
                        color: isActiveScope ? THEME_ACCENT : branch.current ? THEME_SUCCESS_TEXT : branch.isWorktree ? THEME_WORKTREE_TEXT : 'var(--t-text-muted)',
                        marginTop: branch.isWorktree ? 2 : 1,
                      }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: branch.isWorktree ? 1 : 0, flex: 1, minWidth: 0 }}>
                      <span style={{
                        fontSize: 11.5,
                        fontWeight: branch.current || branch.isWorktree ? 620 : 560,
                        color: 'var(--t-text)',
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {branch.name}
                      </span>
                      {branch.isWorktree ? (
                        <span style={{
                          fontSize: 10,
                          lineHeight: 1.2,
                          color: 'var(--t-text-faint)',
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {worktreeTone?.label ?? 'Workspace tracked'}
                        </span>
                      ) : null}
                    </div>
                    {isActiveScope ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '2px 7px',
                          borderRadius: 999,
                          background: THEME_ACCENT_SOFT,
                          border: `1px solid ${THEME_ACCENT_BORDER}`,
                          color: THEME_ACCENT,
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          flexShrink: 0,
                          marginTop: branch.isWorktree ? 0 : 1,
                        }}
                      >
                        Current
                      </span>
                    ) : null}
                    {branchDiffAgent ? (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: 'var(--t-text-secondary)',
                          fontFamily: '"SF Mono", ui-monospace, monospace',
                          letterSpacing: '-0.01em',
                          flexShrink: 0,
                        }}
                      >
                        +{(branchDiffAgent.additions ?? 0).toLocaleString()} -{(branchDiffAgent.deletions ?? 0).toLocaleString()}
                      </span>
                    ) : null}
                  </div>
                  {orderedBranchAgents.length > 0 ? (
                    <div
                      style={{
                        marginLeft: 24,
                        marginTop: 4,
                        marginBottom: 7,
                        paddingLeft: 12,
                        borderLeft: '1px solid var(--t-divider-subtle)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSessionDisclosureByBranch((current) => ({
                            ...current,
                            [branch.name]: !(current[branch.name] ?? true),
                          }));
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          width: '100%',
                          padding: 0,
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--t-text-faint)',
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          cursor: 'pointer',
                          fontFamily: '-apple-system, system-ui, sans-serif',
                        }}
                      >
                        {sessionsExpanded ? <ChevronDown size={12} strokeWidth={2.2} /> : <ChevronRight size={12} strokeWidth={2.2} />}
                        <span>Sessions</span>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minWidth: 18,
                            height: 18,
                            padding: '0 6px',
                            borderRadius: 999,
                            background: 'var(--t-divider-subtle)',
                            color: 'var(--t-text-secondary)',
                            fontSize: 10,
                            fontWeight: 700,
                            fontFamily: '"SF Mono", ui-monospace, monospace',
                            textTransform: 'none',
                            letterSpacing: 'normal',
                          }}
                        >
                          {orderedBranchAgents.length}
                        </span>
                      </button>
                      {sessionsExpanded ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {orderedBranchAgents.map((agent) => {
                            const runtimeTone = runtimeBadgeTone(agent.runtime);
                            const statusTone = sessionStatusTone(agent.status);
                            const isSelectedSession = activeSessionKey === agent.sessionKey;
                            return (
                              <button
                                key={agent.sessionKey}
                                type="button"
                                disabled={!onSelectSession}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onSelectSession?.(agent.sessionKey);
                                }}
                                style={{
                                  width: '100%',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 10,
                                  padding: '8px 10px',
                                  borderRadius: 12,
                                  border: isSelectedSession ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)',
                                  background: isSelectedSession ? THEME_ACCENT_SOFT : 'rgba(255, 255, 255, 0.56)',
                                  color: 'var(--t-text)',
                                  cursor: onSelectSession ? 'pointer' : 'default',
                                  fontFamily: '-apple-system, system-ui, sans-serif',
                                  textAlign: 'left',
                                  boxShadow: isSelectedSession ? `0 0 0 1px ${THEME_ACCENT_RING}` : 'none',
                                  transition: 'background 160ms ease, border-color 160ms ease, box-shadow 160ms ease',
                                  opacity: onSelectSession ? 1 : 0.78,
                                }}
                              >
                                <span
                                  title={runtimeTone.label}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    width: 28,
                                    height: 28,
                                    borderRadius: 999,
                                    background: runtimeTone.background,
                                    border: `1px solid ${runtimeTone.border}`,
                                    color: runtimeTone.color,
                                    fontSize: 10,
                                    fontWeight: 700,
                                    letterSpacing: '-0.01em',
                                    flexShrink: 0,
                                  }}
                                >
                                  {runtimeTone.shortLabel}
                                </span>
                                <span style={{ flex: 1, minWidth: 0 }}>
                                  <span
                                    style={{
                                      display: 'block',
                                      fontSize: 11.5,
                                      fontWeight: 620,
                                      lineHeight: 1.35,
                                      color: 'var(--t-text)',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    {branchSessionLabel(agent)}
                                  </span>
                                  <span
                                    style={{
                                      display: 'block',
                                      marginTop: 1,
                                      fontSize: 10,
                                      lineHeight: 1.3,
                                      color: 'var(--t-text-faint)',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    {runtimeTone.label}
                                  </span>
                                </span>
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    flexShrink: 0,
                                    fontSize: 10,
                                    fontWeight: 700,
                                    color: statusTone.color,
                                  }}
                                >
                                  <span
                                    style={{
                                      width: 7,
                                      height: 7,
                                      borderRadius: '50%',
                                      background: statusTone.color,
                                      boxShadow: `0 0 10px ${statusTone.glow}`,
                                    }}
                                  />
                                  <span>{statusTone.label}</span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {hoveredBranchName === branch.name && branchHoverRect && typeof document !== 'undefined' ? createPortal(
                    <div
                      onMouseEnter={holdBranchHover}
                      onMouseLeave={closeBranchHover}
                      style={{
                        position: 'fixed',
                        zIndex: 10000,
                        width: 320,
                        padding: '14px 15px 13px',
                        borderRadius: 18,
                        border: '1px solid var(--t-panel-border)',
                        background: 'linear-gradient(180deg, rgba(68, 75, 85, 0.96), rgba(54, 60, 69, 0.94))',
                        backdropFilter: 'blur(28px) saturate(1.2)',
                        WebkitBackdropFilter: 'blur(28px) saturate(1.2)',
                        boxShadow: '0 22px 56px rgba(0, 0, 0, 0.28), 0 8px 24px rgba(15, 23, 42, 0.12)',
                        color: 'var(--t-text)',
                        ...resolveFloatingPanelPosition(branchHoverRect, 320),
                      }}
                    >
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: worktreeTone?.color ?? (branch.current ? THEME_SUCCESS_TEXT : THEME_ACCENT) }}>
                        {branch.isWorktree ? (worktreeTone?.label ?? 'Worktree') : branch.current ? 'Current Branch' : 'Branch'}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 15, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--t-text)' }}>
                        {branch.name}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: '3px 8px' }}>
                          {branch.lastCommitAge}
                        </span>
                        {branchAgentLabel ? (
                          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: '3px 8px' }}>
                            {branchAgentLabel}
                          </span>
                        ) : null}
                        {branchDiffAgent ? (
                          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: '3px 8px', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                            +{(branchDiffAgent.additions ?? 0).toLocaleString()} -{(branchDiffAgent.deletions ?? 0).toLocaleString()}
                          </span>
                        ) : null}
                        {branch.ahead > 0 || branch.behind > 0 ? (
                          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: '3px 8px', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                            {branch.ahead > 0 ? `↑${branch.ahead}` : ''}{branch.behind > 0 ? ` ↓${branch.behind}` : ''}
                          </span>
                        ) : null}
                        {branch.diskSize ? (
                          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-secondary)', background: 'var(--t-divider-subtle)', border: '1px solid var(--t-panel-border)', borderRadius: 999, padding: '3px 8px', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                            {branch.diskSize}
                          </span>
                        ) : null}
                        {worktree ? (
                          <span style={{ fontSize: 10, fontWeight: 700, color: worktreeTone?.color ?? THEME_WORKTREE_TEXT, background: worktreeTone?.background ?? THEME_WORKTREE_SOFT, border: `1px solid ${worktreeTone?.border ?? THEME_WORKTREE_BORDER}`, borderRadius: 999, padding: '3px 8px' }}>
                            {worktree.status === 'stale' ? 'Needs cleanup' : 'Workspace tracked'}
                          </span>
                        ) : null}
                      </div>
                      {branchAgents.length > 0 ? (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                          {branchAgents.map((agent) => (
                            <span
                              key={agent.sessionKey}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 10,
                                fontWeight: 700,
                                color: 'var(--t-text-secondary)',
                                background: 'var(--t-panel-hover)',
                                border: '1px solid var(--t-panel-border)',
                                borderRadius: 999,
                                padding: '4px 8px',
                              }}
                            >
                              <span
                                style={{
                                  width: 6,
                                  height: 6,
                                  borderRadius: '50%',
                                  background: agent.color,
                                  boxShadow: `0 0 10px ${agent.color}55`,
                                }}
                              />
                              {agent.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
                        {branch.lastCommitMessage || (branch.current ? 'Current branch checked out in this repository.' : 'Click the row to switch to this branch.')}
                      </div>
                      {worktree?.path ? (
                        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace', lineHeight: 1.5 }}>
                          {shortenPath(worktree.path)}
                        </div>
                      ) : null}
                      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--t-divider-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>
                          {branch.current ? 'Current branch' : 'Click row to switch'}
                        </span>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {branchAgents.map((agent) => (
                            onSelectSession ? (
                              <RepoActionButton
                                key={agent.sessionKey}
                                label={`Open ${agent.name}`}
                                icon={<PlayCircle size={12} strokeWidth={2} />}
                                onClick={() => onSelectSession(agent.sessionKey)}
                              />
                            ) : null
                          ))}
                          {worktree ? (
                            <RepoActionButton
                              label="Open workspace"
                              icon={<FolderOpen size={12} strokeWidth={2} />}
                              onClick={() => { void handleOpenDesktopPath('finder', worktree.path); }}
                            />
                          ) : null}
                          {canOpenPr ? (
                            <RepoActionButton
                              label="Open PR"
                              icon={<ExternalLink size={12} strokeWidth={2} />}
                              onClick={() => window.open(`${githubUrl}/compare/${branch.name}?expand=1`, '_blank')}
                              active
                            />
                          ) : null}
                          {!branch.current ? (
                            <RepoActionButton
                              label={worktree?.status === 'stale' ? 'Clean up worktree' : branch.isWorktree ? 'Delete worktree' : 'Delete branch'}
                              icon={<Trash2 size={12} strokeWidth={2} />}
                              onClick={() => {
                                if (worktree?.status === 'stale') {
                                  void handleCleanupWorktree(worktree);
                                  return;
                                }
                                handleDeleteBranch(branch.name);
                              }}
                              danger
                            />
                          ) : null}
                        </div>
                      </div>
                    </div>,
                    document.body,
                  ) : null}
                  {/* Force delete confirmation */}
                  {branchDeleteConfirm === branch.name ? (
                    <div style={{
                      marginLeft: 30 + 6,
                      marginBottom: 4,
                      padding: '6px 8px',
                      borderRadius: 8,
                      border: '1px solid rgba(239,68,68,0.15)',
                      background: 'rgba(254,242,242,0.9)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}>
                      <AlertCircle size={11} strokeWidth={2} style={{ color: '#dc2626', flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: '#991b1b', flex: 1 }}>Not fully merged.</span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleDeleteBranch(branch.name, true); }}
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: '#dc2626',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '2px 6px',
                        }}
                      >
                        Force delete
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setBranchDeleteConfirm(null); }}
                        style={{
                          fontSize: 10,
                          fontWeight: 500,
                          color: 'var(--t-text-muted)',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '2px 6px',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : null}
                  </div>
                )})}
              </div>
            ) : null}
          </div>

          {/* Create branch inline */}
          {createBranchOpen ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '10px',
              marginTop: 6,
              borderRadius: 12,
              background: 'var(--t-divider-subtle)',
              border: '1px solid var(--t-panel-border)',
            }}>
              <input
                id={`create-branch-name-${repo.id}`}
                name={`create-branch-name-${repo.id}`}
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.currentTarget.value)}
                placeholder="feat/my-feature"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateBranch(); if (e.key === 'Escape') { setCreateBranchOpen(false); setNewBranchName(''); } }}
                style={{
                  width: '100%',
                  minHeight: 42,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--t-input-border)',
                  background: 'var(--t-input-bg)',
                  fontSize: 12,
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  outline: 'none',
                  color: 'var(--t-text)',
                }}
              />
              <div style={{ fontSize: 10, lineHeight: 1.45, color: 'var(--t-text-muted)' }}>
                {newBranchWorktree
                  ? `Create an isolated worktree from ${repo.defaultBranch}.`
                  : `Create a branch from ${repo.defaultBranch}.`}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 10, color: 'var(--t-text-secondary)' }}>
                  <input
                    id={`create-branch-worktree-${repo.id}`}
                    name={`create-branch-worktree-${repo.id}`}
                    type="checkbox"
                    checked={newBranchWorktree}
                    onChange={(e) => setNewBranchWorktree(e.currentTarget.checked)}
                    style={{ accentColor: '#f59e0b' }}
                  />
                  Create worktree
                </label>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => { setCreateBranchOpen(false); setNewBranchName(''); setNewBranchError(null); }}
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--t-text-secondary)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '4px 6px',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCreateBranch}
                  disabled={newBranchCreating || !newBranchName.trim()}
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: THEME_ACCENT,
                    background: THEME_ACCENT_SOFT,
                    border: `1px solid ${THEME_ACCENT_BORDER}`,
                    borderRadius: 999,
                    padding: '6px 10px',
                    cursor: newBranchCreating || !newBranchName.trim() ? 'not-allowed' : 'pointer',
                    opacity: newBranchCreating || !newBranchName.trim() ? 0.5 : 1,
                  }}
                >
                  {newBranchCreating ? 'Creating…' : 'Create'}
                </button>
              </div>
              {newBranchError ? (
                <div style={{ fontSize: 10, color: '#dc2626' }}>{newBranchError}</div>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setCreateBranchOpen(true); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '6px 7px',
                marginTop: 2,
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-muted)',
                fontSize: 11,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
                borderRadius: 8,
                transition: 'background 140ms ease, color 140ms ease',
              }}
              onMouseEnter={(e) => {
                const target = e.currentTarget as HTMLButtonElement;
                target.style.color = 'var(--t-text)';
                target.style.background = 'var(--t-panel-hover)';
              }}
              onMouseLeave={(e) => {
                const target = e.currentTarget as HTMLButtonElement;
                target.style.color = 'var(--t-text-muted)';
                target.style.background = 'transparent';
              }}
            >
              <Plus size={11} strokeWidth={2} />
              New branch
            </button>
          )}

          {/* Dirty check dialog — appears when checkout blocked by uncommitted changes */}
          {checkoutDirty && checkoutTarget ? (
            <div style={{
              margin: '6px 0',
              padding: 10,
              borderRadius: 10,
              background: 'rgba(245,158,11,0.04)',
              border: '1px solid rgba(245,158,11,0.12)',
            }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: '#b45309',
                marginBottom: 6,
              }}>
                {checkoutDirty.fileCount} uncommitted change{checkoutDirty.fileCount === 1 ? '' : 's'}
              </div>
              <div style={{
                fontSize: 10, color: 'var(--t-text-secondary)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                marginBottom: 8,
                maxHeight: 60,
                overflow: 'auto',
                lineHeight: 1.5,
              }}>
                {checkoutDirty.files.map((f, i) => (
                  <div key={i}>{f}</div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => handleCheckout(checkoutTarget, { stash: true })}
                  disabled={checkoutBusy}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: '1px solid rgba(37,99,235,0.15)',
                    background: 'rgba(37,99,235,0.06)',
                    color: '#2563eb',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}
                >
                  Stash & switch
                </button>
                <button
                  type="button"
                  onClick={() => handleCheckout(checkoutTarget, { force: true })}
                  disabled={checkoutBusy}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: '1px solid rgba(239,68,68,0.15)',
                    background: 'rgba(239,68,68,0.04)',
                    color: '#dc2626',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}
                >
                  Force
                </button>
                <button
                  type="button"
                  onClick={() => { setCheckoutTarget(null); setCheckoutDirty(null); }}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--t-btn-secondary-border)',
                    background: 'transparent',
                    color: 'var(--t-text-secondary)',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {/* Stale branch summary */}
          {showInlineRepoMeta ? (() => {
            const staleBranches = branches.filter(b => b.isStale);
            if (staleBranches.length === 0) return null;
            const idleWorktreeBranches = staleBranches.filter((branch) => branch.isWorktree);
            const staleRegularBranches = staleBranches.filter((branch) => !branch.isWorktree);
            const totalDisk = worktreeSummary?.totalDiskUsage
              ? formatBytes(worktreeSummary.totalDiskUsage)
              : staleBranches.filter((branch) => branch.diskSize).map((branch) => branch.diskSize!).join(' + ');
            const hasIdleWorktree = idleWorktreeBranches.length > 0;
            const summaryLabel = hasIdleWorktree
              ? `${idleWorktreeBranches.length} idle worktree${idleWorktreeBranches.length > 1 ? 's' : ''}${staleRegularBranches.length > 0 ? ` · ${staleRegularBranches.length} stale branch${staleRegularBranches.length > 1 ? 'es' : ''}` : ''}`
              : `${staleRegularBranches.length} stale branch${staleRegularBranches.length > 1 ? 'es' : ''}`;
            return (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 8px',
                marginTop: 4,
                borderRadius: 8,
                background: hasIdleWorktree ? 'rgba(245, 158, 11, 0.08)' : 'var(--t-divider-subtle)',
                border: hasIdleWorktree ? `1px solid ${THEME_WORKTREE_BORDER}` : '1px solid var(--t-panel-border)',
              }}>
                <AlertCircle size={11} strokeWidth={2} style={{ color: hasIdleWorktree ? THEME_WORKTREE_TEXT : 'var(--t-text-secondary)', flexShrink: 0 }} />
                <span style={{ fontSize: 10, color: hasIdleWorktree ? THEME_WORKTREE_TEXT : 'var(--t-text-secondary)', flex: 1, fontWeight: 600 }}>
                  {summaryLabel}
                  {totalDisk ? ` · ${totalDisk}` : ''}
                </span>
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (hasIdleWorktree) {
                      await handlePruneStaleWorktrees();
                      return;
                    }
                    for (const sb of staleBranches) {
                      await handleDeleteBranch(sb.name, true);
                    }
                  }}
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: hasIdleWorktree ? THEME_WORKTREE_TEXT : 'var(--t-text-secondary)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    borderRadius: 4,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}
                >
                  {hasIdleWorktree ? 'Prune' : 'Clean up'}
                </button>
              </div>
            );
          })() : null}

          {/* Repo metadata — compact */}
          {showInlineRepoMeta ? (
            <div
              style={{
                fontSize: 10,
                color: 'var(--t-text-muted)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                lineHeight: 1.6,
                marginTop: 6,
              }}
            >
              <div style={{ color: 'var(--t-text-secondary)' }}>{shortenPath(repo.localPath)}</div>
              {repo.remoteUrl ? (
                <div style={{ color: 'var(--t-text-faint)' }}>{repo.remoteUrl.replace(/^https?:\/\//, '')}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Settings panel (inline, below card when open) */}
      {settingsOpen ? (
        <div
          style={{
            borderTop: '1px solid var(--t-divider-subtle)',
            padding: '12px 14px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--t-text)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Setup Profile
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                lineHeight: 1.45,
                color: 'var(--t-text-muted)',
              }}
            >
              Environment handling and optional bootstrap commands are stored per repo here. Build and env hooks are scaffolded and not yet injected into workspace bootstrap.
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
              Environment files
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <SetupModeButton label="Copy" selected={draftSetup.envMode === 'copy'} onClick={() => updateEnvMode('copy')} />
              <SetupModeButton label="Symlink" selected={draftSetup.envMode === 'symlink'} onClick={() => updateEnvMode('symlink')} />
              <SetupModeButton label="Skip" selected={draftSetup.envMode === 'skip'} onClick={() => updateEnvMode('skip')} />
            </div>
            <input
              id={`repo-setup-env-files-${repo.id}`}
              name={`repo-setup-env-files-${repo.id}`}
              value={draftSetup.envFiles.join(', ')}
              onChange={(event) => {
                const envFiles = event.currentTarget.value.split(',');
                setDraftSetup((current) => ({
                  ...current,
                  envFiles,
                }));
              }}
              placeholder=".env, .env.local"
              style={{
                width: '100%',
                minHeight: 36,
                padding: '9px 11px',
                borderRadius: 10,
                border: '1px solid var(--t-btn-secondary-border)',
                background: 'rgba(255, 255, 255, 0.55)',
                color: 'var(--t-text)',
                fontSize: 12,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                outline: 'none',
              }}
            />
          </div>

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              cursor: 'pointer',
            }}
          >
            <input
              id={`repo-setup-install-${repo.id}`}
              name={`repo-setup-install-${repo.id}`}
              type="checkbox"
              checked={draftSetup.installOnCreateWorkspace}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setDraftSetup((current) => ({
                  ...current,
                  installOnCreateWorkspace: checked,
                }));
              }}
              style={{
                marginTop: 2,
                accentColor: '#ef4444',
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
                Install dependencies on workspace create
              </div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: 'var(--t-text-muted)',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  lineHeight: 1.45,
                }}
              >
                {draftSetup.installCommand ?? 'No install command detected'}
              </div>
            </div>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              cursor: 'pointer',
            }}
          >
            <input
              id={`repo-setup-build-${repo.id}`}
              name={`repo-setup-build-${repo.id}`}
              type="checkbox"
              checked={draftSetup.runBuildOnCreateWorkspace}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setDraftSetup((current) => ({
                  ...current,
                  runBuildOnCreateWorkspace: checked,
                }));
              }}
              style={{
                marginTop: 2,
                accentColor: '#ef4444',
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
                Run build after setup
              </div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: 'var(--t-text-muted)',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  lineHeight: 1.45,
                }}
              >
                {draftSetup.buildCommand ?? 'No build command detected'}
              </div>
            </div>
          </label>

          {/* Dev command */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
              Dev command
            </div>
            <input
              id={`repo-setup-dev-command-${repo.id}`}
              name={`repo-setup-dev-command-${repo.id}`}
              value={draftSetup.devCommand ?? ''}
              onChange={(e) => setDraftSetup(current => ({ ...current, devCommand: e.currentTarget.value || null }))}
              placeholder="npm run dev"
              style={{
                width: '100%',
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid var(--t-btn-secondary-border)',
                background: 'rgba(255,255,255,0.55)',
                fontSize: 11,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                outline: 'none',
                color: 'var(--t-text)',
              }}
            />
            <div style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>
              Starts the development server from the repo card.
            </div>
          </div>

          {/* Default port */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
              Default port
            </div>
            <input
              id={`repo-setup-default-port-${repo.id}`}
              name={`repo-setup-default-port-${repo.id}`}
              value={draftSetup.defaultPort ?? ''}
              onChange={(e) => {
                const val = e.currentTarget.value.trim();
                setDraftSetup(current => ({ ...current, defaultPort: val ? parseInt(val, 10) || null : null }));
              }}
              placeholder="Auto-detect"
              type="number"
              style={{
                width: 100,
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid var(--t-btn-secondary-border)',
                background: 'rgba(255,255,255,0.55)',
                fontSize: 11,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                outline: 'none',
                color: 'var(--t-text)',
              }}
            />
            <div style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>
              Port for the preview pane. Leave blank to auto-detect from output.
            </div>
          </div>

          {saveError ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                color: '#b91c1c',
              }}
            >
              <AlertCircle size={13} strokeWidth={2} />
              {saveError}
            </div>
          ) : null}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !hasUnsavedChanges}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                minHeight: 34,
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid rgba(239, 68, 68, 0.2)',
                background: 'rgba(239, 68, 68, 0.08)',
                color: '#b91c1c',
                fontSize: 11,
                fontWeight: 700,
                cursor: saving || !hasUnsavedChanges ? 'not-allowed' : 'pointer',
                opacity: saving || !hasUnsavedChanges ? 0.45 : 1,
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              {saving ? 'Saving…' : 'Save Profile'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftSetup(repo.setup);
                setSaveError(null);
              }}
              disabled={!hasUnsavedChanges || saving}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 34,
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid var(--t-btn-secondary-border)',
                background: 'var(--t-panel-hover)',
                color: 'var(--t-text-secondary)',
                fontSize: 11,
                fontWeight: 600,
                cursor: !hasUnsavedChanges || saving ? 'not-allowed' : 'pointer',
                opacity: !hasUnsavedChanges || saving ? 0.45 : 1,
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              Reset
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function RepoRegistrySection({
  onSelectSession,
  onSelectPR,
  onReviewPR,
  onRepoRemoved,
  onLaunchComplete,
  onLaunchWorkspaceAgent,
  onRegistryStateChange,
  activeSessionKey = null,
  activeRepoLocalPath = null,
  activeWorkspacePath = null,
  sectionOpen,
  onSectionOpenChange,
  launchIntent,
  workspaceIntent,
  addIntent,
  hideHeader = false,
}: {
  onSelectSession?: (sessionKey: string) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onRepoRemoved?: (repo: RepoRegistryEntry) => void;
  onLaunchComplete?: () => void;
  onLaunchWorkspaceAgent?: (request: WorkspaceAgentLaunchRequest) => Promise<void>;
  onRegistryStateChange?: (state: { loading: boolean; count: number; hasError: boolean }) => void;
  activeSessionKey?: string | null;
  activeRepoLocalPath?: string | null;
  activeWorkspacePath?: string | null;
  sectionOpen?: boolean;
  onSectionOpenChange?: (open: boolean) => void;
  launchIntent?: { repoPath: string | null; nonce: number } | null;
  workspaceIntent?: { repoPath: string | null; nonce: number } | null;
  addIntent?: { nonce: number } | null;
  hideHeader?: boolean;
} = {}) {
  const [repos, setRepos] = useState<RepoRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reposOpenInternal, setReposOpenInternal] = useState(true);
  const reposOpen = sectionOpen ?? reposOpenInternal;
  const setReposOpen = useCallback((next: boolean) => {
    if (onSectionOpenChange) onSectionOpenChange(next);
    else setReposOpenInternal(next);
  }, [onSectionOpenChange]);
  const [expandedRepoId, setExpandedRepoId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return sessionStorage.getItem('cortex-repo-expanded-id');
    } catch {
      return null;
    }
  });

  const [addOpen, setAddOpen] = useState(false);
  const [repoPathInput, setRepoPathInput] = useState('');
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<ValidatedRepoCandidate | null>(null);
  const [adding, setAdding] = useState(false);

  const [workspaceRepo, setWorkspaceRepo] = useState<RepoRegistryEntry | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceBaseBranch, setWorkspaceBaseBranch] = useState('');
  const [workspaceUseSetup, setWorkspaceUseSetup] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceResult, setWorkspaceResult] = useState<WorkspaceCreateResult | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<Record<string, WorkspaceCreateResult>>({});

  const [launchRepo, setLaunchRepo] = useState<RepoRegistryEntry | null>(null);
  const [launchRuntime, setLaunchRuntime] = useState<'codex' | 'claude-code'>(() => {
    if (typeof window === 'undefined') return 'codex';
    try {
      const saved = window.localStorage.getItem('cortex-workspace-launch-runtime');
      return saved === 'claude-code' ? 'claude-code' : 'codex';
    } catch {
      return 'codex';
    }
  });
  const [launchTaskName, setLaunchTaskName] = useState('');
  const [launchPrompt, setLaunchPrompt] = useState('');
  const [launchLoading, setLaunchLoading] = useState(false);

  useEffect(() => {
    const handleFocusRepoSetup = (event: Event) => {
      const detail = (event as CustomEvent<FocusRepoSetupDetail>).detail;
      if (!detail) return;
      const targetRepo = repos.find((repo) => repo.id === detail.repoId || repo.localPath === detail.repoPath);
      if (!targetRepo) return;
      setReposOpen(true);
      setExpandedRepoId(targetRepo.id);
      try {
        sessionStorage.setItem('cortex-repo-expanded-id', targetRepo.id);
      } catch {
        // Ignore session storage failures and still reveal the repo.
      }
    };

    window.addEventListener(FOCUS_REPO_SETUP_EVENT, handleFocusRepoSetup as EventListener);
    return () => {
      window.removeEventListener(FOCUS_REPO_SETUP_EVENT, handleFocusRepoSetup as EventListener);
    };
  }, [repos, setReposOpen]);

  const [launchError, setLaunchError] = useState<string | null>(null);

  const [removeTarget, setRemoveTarget] = useState<RepoRegistryEntry | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const handledLaunchIntentNonceRef = useRef<number | null>(null);
  const handledWorkspaceIntentNonceRef = useRef<number | null>(null);
  const handledAddIntentNonceRef = useRef<number | null>(null);
  const [openClawBetaEnabled, setOpenClawBetaEnabled] = useState(() => readOpenClawBetaEnabled());

  useEffect(() => {
    try {
      if (expandedRepoId) sessionStorage.setItem('cortex-repo-expanded-id', expandedRepoId);
      else sessionStorage.removeItem('cortex-repo-expanded-id');
    } catch { /* ignore */ }
  }, [expandedRepoId]);

  useEffect(() => {
    void refreshOpenClawBetaStatus().then((status) => setOpenClawBetaEnabled(status.effective_enabled));
    return subscribeOpenClawBetaEnabled(setOpenClawBetaEnabled);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('cortex-workspace-launch-runtime', launchRuntime);
    } catch {
      // ignore local preference persistence failures
    }
  }, [launchRuntime]);

  const loadRepos = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await requestJson<{ repos: RepoRegistryEntry[] }>('/api/panel/repos');
      setRepos(sortRepoEntries(data.repos ?? []));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load repositories.');
    } finally {
      setLoading(false);
    }
  }, []);

  const touchRepo = useCallback(async (repo: RepoRegistryEntry) => {
    const touched = await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repo.id }),
    });

    setRepos((current) => sortRepoEntries(
      current.map((entry) => (entry.id === repo.id ? touched.repo : entry)),
    ));
  }, []);

  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  useEffect(() => {
    onRegistryStateChange?.({
      loading,
      count: repos.length,
      hasError: Boolean(loadError),
    });
  }, [loadError, loading, onRegistryStateChange, repos.length]);

  // ── Agent ↔ Branch association (#168) ──
  const [agentBranchMap, setAgentBranchMap] = useState<Map<string, Map<string, BranchAgent[]>>>(new Map());

  useEffect(() => {
    function fetchAgentBranches() {
      fetch(appendOpenClawBetaQuery('/api/panel/workspaces', openClawBetaEnabled))
        .then(r => r.json())
        .then((data: { workspaces?: Array<{
          repo: string;
          branch: string;
          agentName: string;
          sessionKey: string;
          runtime?: string;
          agentStatus: string;
          currentTask?: string | null;
          localDiff?: { additions: number; deletions: number; changedFiles: number };
          pr?: { additions: number; deletions: number; changedFiles: number } | null;
        }> }) => {
          const map = new Map<string, Map<string, BranchAgent[]>>();
          const AGENT_COLORS: Record<string, string> = {
            'Assistant': '#111827',
            'Niot': '#2563eb',
            'Hawk': '#f59e0b',
          };
          for (const ws of data.workspaces ?? []) {
            if (!ws.branch || ws.branch.startsWith('surface/')) continue;
            const repoKey = ws.repo;
            if (!map.has(repoKey)) map.set(repoKey, new Map());
            const branchMap = map.get(repoKey)!;
            if (!branchMap.has(ws.branch)) branchMap.set(ws.branch, []);
            // Derive agent display name
            const agentName = ws.agentName.split(' ')[0] || ws.agentName;
            const isCodex = agentName.toLowerCase().includes('codex');
            const isClaude = agentName.toLowerCase().includes('claude');
            const displayName = isCodex ? 'Codex' : isClaude ? 'Claude Code' : agentName;
            const color = AGENT_COLORS[displayName] ?? (isCodex ? '#10b981' : isClaude ? '#8b5cf6' : '#6b7280');
            const diffSource = ws.pr ?? ws.localDiff ?? null;
            // Deduplicate by session key
            const existing = branchMap.get(ws.branch)!;
            if (!existing.some(a => a.sessionKey === ws.sessionKey)) {
              existing.push({
                name: displayName,
                agentName: ws.agentName,
                sessionKey: ws.sessionKey,
                color,
                runtime: ws.runtime ?? (isClaude ? 'claude-code' : 'codex'),
                status: ws.agentStatus,
                currentTask: ws.currentTask ?? null,
                additions: diffSource?.additions,
                deletions: diffSource?.deletions,
                changedFiles: diffSource?.changedFiles,
              });
            }
          }
          setAgentBranchMap(map);
        })
        .catch(() => {});
    }
    fetchAgentBranches();
    const id = setInterval(fetchAgentBranches, 30_000);
    return () => clearInterval(id);
  }, [openClawBetaEnabled]);

  // ── Port data for running indicators (#170) ──
  const [portsByRepo, setPortsByRepo] = useState<Map<string, number[]>>(new Map());

  useEffect(() => {
    function fetchPorts() {
      fetch('/api/panel/ports')
        .then(r => r.json())
        .then((data: { groups?: { repo: string; ports: number[] }[] }) => {
          const map = new Map<string, number[]>();
          for (const g of data.groups ?? []) {
            map.set(g.repo, g.ports);
          }
          setPortsByRepo(map);
        })
        .catch(() => {});
    }
    fetchPorts();
    const id = setInterval(fetchPorts, 10_000);
    return () => clearInterval(id);
  }, []);

  const resetAddModal = useCallback(() => {
    setAddOpen(false);
    setRepoPathInput('');
    setValidationError(null);
    setValidationResult(null);
    setValidating(false);
    setAdding(false);
  }, []);

  const validateRepoPath = useCallback(async (localPath: string) => {
    setValidating(true);
    setValidationError(null);
    setValidationResult(null);

    try {
      const data = await requestJson<{ repo: ValidatedRepoCandidate }>('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'validate', localPath }),
      });
      setValidationResult(data.repo);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Validation failed.');
    } finally {
      setValidating(false);
    }
  }, []);

  const pickFolderPath = useCallback(async () => {
    let folderPath: string | null = null;

    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({ directory: true, title: 'Select project folder' });
      if (typeof result === 'string') folderPath = result;
    } catch {
      try {
        const response = await fetch('/api/panel/browse-folder', { method: 'POST' });
        const data = await response.json() as { path?: string | null };
        if (typeof data.path === 'string') folderPath = data.path;
      } catch {
        folderPath = window.prompt('Enter folder path:');
      }
    }

    const trimmedPath = folderPath?.trim() ?? '';
    return trimmedPath.length > 0 ? trimmedPath : null;
  }, []);

  const handleBrowseForRepo = useCallback(async () => {
    setAddOpen(true);
    setValidationError(null);
    setValidationResult(null);
    setValidating(false);
    setAdding(false);
    const folderPath = await pickFolderPath();
    if (!folderPath) return;
    setRepoPathInput(folderPath);
    await validateRepoPath(folderPath);
  }, [pickFolderPath, validateRepoPath]);

  const handleValidate = useCallback(async () => {
    const localPath = repoPathInput.trim();
    if (!localPath) {
      setValidationError('Enter a local folder path.');
      setValidationResult(null);
      return;
    }

    await validateRepoPath(localPath);
  }, [repoPathInput, validateRepoPath]);

  const handleAddRepo = useCallback(async () => {
    const localPath = repoPathInput.trim();
    if (!localPath) {
      setValidationError('Enter a local folder path.');
      return;
    }

    setAdding(true);
    setValidationError(null);

    try {
      await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', localPath }),
      });
      await loadRepos();
      resetAddModal();
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Unable to add repository.');
    } finally {
      setAdding(false);
    }
  }, [loadRepos, repoPathInput, resetAddModal]);

  const handleSaveSetup = useCallback(async (repoId: string, setup: RepoSetupConfig) => {
    const data = await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', id: repoId, setup }),
    });

    setRepos((current) => sortRepoEntries(
      current.map((repo) => (repo.id === repoId ? data.repo : repo)),
    ));
  }, []);

  const handleOpenGitHub = useCallback((repo: RepoRegistryEntry) => {
    const githubUrl = githubUrlFromRemote(repo.remoteUrl);
    if (!githubUrl) return;

    void requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'touch', id: repo.id }),
    }).then((data) => {
      setRepos((current) => sortRepoEntries(
        current.map((entry) => (entry.id === repo.id ? data.repo : entry)),
      ));
    }).catch(() => null);

    window.open(githubUrl, '_blank', 'noopener,noreferrer');
  }, []);

  const openLaunchModal = useCallback((repo: RepoRegistryEntry) => {
    setLaunchRepo(repo);
    setLaunchTaskName('');
    setLaunchPrompt('');
    setLaunchError(null);
  }, []);

  const closeLaunchModal = useCallback(() => {
    setLaunchRepo(null);
    setLaunchTaskName('');
    setLaunchPrompt('');
    setLaunchLoading(false);
    setLaunchError(null);
  }, []);

  const launchIntoWorkspace = useCallback(async (
    repo: RepoRegistryEntry,
    options?: {
      runtime?: 'codex' | 'claude-code';
      label?: string;
      initialText?: string;
      autoSend?: boolean;
    },
  ) => {
    if (!onLaunchWorkspaceAgent) {
      openLaunchModal(repo);
      return;
    }

    await onLaunchWorkspaceAgent({
      repoPath: repo.localPath,
      runtime: options?.runtime,
      label: options?.label,
      initialText: options?.initialText,
      autoSend: options?.autoSend,
      createNew: true,
    });

    try {
      await touchRepo(repo);
    } catch {
      // Repo recency is best-effort; do not fail the launch if touch misses.
    }
    onLaunchComplete?.();
  }, [onLaunchComplete, onLaunchWorkspaceAgent, openLaunchModal, touchRepo]);

  const handleLaunchAgent = useCallback(async () => {
    if (!launchRepo) return;

    setLaunchLoading(true);
    setLaunchError(null);

    try {
      await launchIntoWorkspace(launchRepo, {
        runtime: launchRuntime,
        label: launchTaskName.trim() || undefined,
        initialText: launchPrompt.trim() || undefined,
        autoSend: launchPrompt.trim().length > 0,
      });
      closeLaunchModal();
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : 'Unable to launch agent.');
    } finally {
      setLaunchLoading(false);
    }
  }, [
    launchPrompt,
    launchRepo,
    launchRuntime,
    launchTaskName,
    closeLaunchModal,
    launchIntoWorkspace,
  ]);

  const openWorkspaceModal = useCallback((repo: RepoRegistryEntry) => {
    setWorkspaceRepo(repo);
    setWorkspaceName(defaultWorkspaceName(repo.name));
    setWorkspaceBaseBranch(repo.defaultBranch);
    setWorkspaceUseSetup(repo.setup.installOnCreateWorkspace);
    setWorkspaceError(null);
    setWorkspaceResult(null);
  }, []);

  const closeWorkspaceModal = useCallback(() => {
    setWorkspaceRepo(null);
    setWorkspaceName('');
    setWorkspaceBaseBranch('');
    setWorkspaceUseSetup(true);
    setWorkspaceError(null);
    setWorkspaceResult(null);
    setWorkspaceLoading(false);
  }, []);

  useEffect(() => {
    const handleOpenRepoWorkspace = (event: Event) => {
      const detail = (event as CustomEvent<OpenRepoWorkspaceDetail>).detail;
      if (!detail) return;
      const targetRepo = repos.find((repo) => repo.id === detail.repoId || repo.localPath === detail.repoPath);
      if (!targetRepo) return;
      setReposOpen(true);
      setExpandedRepoId(targetRepo.id);
      openWorkspaceModal(targetRepo);
      try {
        sessionStorage.setItem('cortex-repo-expanded-id', targetRepo.id);
      } catch {
        // Ignore session storage failures and still reveal the repo.
      }
    };

    window.addEventListener(OPEN_REPO_WORKSPACE_EVENT, handleOpenRepoWorkspace as EventListener);
    return () => {
      window.removeEventListener(OPEN_REPO_WORKSPACE_EVENT, handleOpenRepoWorkspace as EventListener);
    };
  }, [openWorkspaceModal, repos, setReposOpen]);

  const handleCreateWorkspace = useCallback(async () => {
    if (!workspaceRepo) return;

    const taskName = workspaceName.trim();
    if (!taskName) {
      setWorkspaceError('Workspace name is required.');
      return;
    }

    setWorkspaceLoading(true);
    setWorkspaceError(null);

    try {
      const data = await requestJson<{ worktree: WorkspaceCreateResult }>('/api/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: workspaceRepo.localPath,
          agentType: 'workspace',
          taskName,
          baseBranch: workspaceBaseBranch.trim() || undefined,
          skipSetup: !workspaceUseSetup,
          envMode: workspaceRepo.setup.envMode,
          envFiles: workspaceRepo.setup.envFiles,
        }),
      });

      setWorkspaceResult(data.worktree);
      setWorkspaceNotice((current) => ({
        ...current,
        [workspaceRepo.id]: data.worktree,
      }));

      const touched = await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'touch', id: workspaceRepo.id }),
      });

      setRepos((current) => sortRepoEntries(
        current.map((repo) => (repo.id === workspaceRepo.id ? touched.repo : repo)),
      ));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Unable to create workspace.');
    } finally {
      setWorkspaceLoading(false);
    }
  }, [workspaceBaseBranch, workspaceName, workspaceRepo, workspaceUseSetup]);

  const handleRemoveRepo = useCallback(async () => {
    if (!removeTarget) return;

    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await requestJson<{ ok: boolean }>('/api/panel/repos', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: removeTarget.id }),
      });
      setRepos((current) => current.filter((repo) => repo.id !== removeTarget.id));
      setWorkspaceNotice((current) => {
        const next = { ...current };
        delete next[removeTarget.id];
        return next;
      });
      onRepoRemoved?.(removeTarget);
      setRemoveTarget(null);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'Unable to remove repository.');
    } finally {
      setRemoveBusy(false);
    }
  }, [onRepoRemoved, removeTarget]);

  const activeRepoEntry = useMemo(
    () => repos.find((repo) => repo.localPath === activeRepoLocalPath) ?? null,
    [activeRepoLocalPath, repos],
  );

  const orderedRepos = useMemo(() => {
    if (!activeRepoEntry) return repos;
    return [activeRepoEntry, ...repos.filter((repo) => repo.id !== activeRepoEntry.id)];
  }, [activeRepoEntry, repos]);

  useEffect(() => {
    if (!activeRepoEntry) return;
    setExpandedRepoId((current) => current ?? activeRepoEntry.id);
  }, [activeRepoEntry]);

  useEffect(() => {
    if (!launchIntent?.repoPath) return;
    if (handledLaunchIntentNonceRef.current === launchIntent.nonce) return;
    const match = repos.find((repo) => repo.localPath === launchIntent.repoPath);
    if (!match) return;
    handledLaunchIntentNonceRef.current = launchIntent.nonce;
    setReposOpen(true);
    setExpandedRepoId(match.id);
    openLaunchModal(match);
  }, [launchIntent?.nonce, launchIntent?.repoPath, openLaunchModal, repos, setReposOpen]);

  useEffect(() => {
    if (!workspaceIntent?.repoPath) return;
    if (handledWorkspaceIntentNonceRef.current === workspaceIntent.nonce) return;
    const match = repos.find((repo) => repo.localPath === workspaceIntent.repoPath);
    if (!match) return;
    handledWorkspaceIntentNonceRef.current = workspaceIntent.nonce;
    setReposOpen(true);
    setExpandedRepoId(match.id);
    openWorkspaceModal(match);
  }, [openWorkspaceModal, repos, setReposOpen, workspaceIntent?.nonce, workspaceIntent?.repoPath]);

  useEffect(() => {
    if (!addIntent?.nonce) return;
    if (handledAddIntentNonceRef.current === addIntent.nonce) return;
    handledAddIntentNonceRef.current = addIntent.nonce;
    setReposOpen(true);
    void handleBrowseForRepo();
  }, [addIntent?.nonce, handleBrowseForRepo, setReposOpen]);

  const branchPreview = useMemo(() => getWorkspaceBranchPreview(workspaceName), [workspaceName]);
  const showEmptyState = !loading && !loadError && repos.length === 0;

  return (
    <>
      {!hideHeader ? (
        <div style={{ flexShrink: 0, paddingLeft: 14, paddingRight: 14, paddingTop: 0, paddingBottom: 0 }}>
          <button
            type="button"
            onClick={() => setReposOpen(!reposOpen)}
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
            <FolderOpen size={12} strokeWidth={2} color={reposOpen ? '#ef4444' : 'var(--t-text-muted)'} />
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: reposOpen ? 'var(--t-text)' : 'var(--t-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              Repositories
            </span>
            <span
              style={{
                fontSize: 10,
                color: 'var(--t-text-faint)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}
            >
              {loading ? (
                <span style={{
                  display: 'inline-flex',
                  width: 16,
                  height: 10,
                  borderRadius: 999,
                  background: 'linear-gradient(90deg, rgba(148,163,184,0.14), rgba(148,163,184,0.28), rgba(148,163,184,0.14))',
                }} />
              ) : repos.length}
            </span>
          </button>
        </div>
      ) : null}

      {reposOpen ? (
        <div
          style={{
            flexShrink: 0,
            marginLeft: hideHeader ? -14 : 0,
            marginRight: hideHeader ? -14 : 0,
            paddingTop: 0,
            paddingRight: hideHeader ? 0 : 14,
            paddingBottom: showEmptyState ? 0 : 8,
            paddingLeft: hideHeader ? 0 : 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 0,
          }}
        >
          {/* Compact repo list */}

          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, paddingTop: 4 }}>
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  style={{
                    borderBottom: '1px solid var(--t-divider-subtle)',
                    padding: '12px 0 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ width: `${58 + index * 12}%`, height: 12, borderRadius: 999, background: 'var(--t-divider-strong)' }} />
                  <div style={{ width: `${42 + index * 10}%`, height: 10, borderRadius: 999, background: 'var(--t-divider)' }} />
                </div>
              ))}
            </div>
          ) : null}

          {loadError ? (
            <div
              style={{
                padding: '12px 0',
                borderBottom: '1px solid rgba(239, 68, 68, 0.16)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: 12,
                color: '#991b1b',
              }}
            >
              <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{loadError}</span>
            </div>
          ) : null}

          {showEmptyState ? (
            <div
              style={{
                padding: '8px 0 2px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '9px 12px',
                  borderRadius: 16,
                  border: '1px solid var(--t-panel-border)',
                  background: `linear-gradient(180deg, ${THEME_PANEL_GLASS} 0%, ${THEME_BG_CARD} 100%)`,
                  boxShadow: '0 10px 24px rgba(4, 8, 14, 0.12), inset 0 1px 0 var(--t-divider-subtle)',
                }}
              >
                <span
                  style={{
                    width: 24,
                    height: 24,
                    marginTop: 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 999,
                    background: THEME_ACCENT_SOFT,
                    color: THEME_ACCENT,
                    flexShrink: 0,
                  }}
                >
                  <FolderOpen size={13} strokeWidth={2.1} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 11.5,
                      fontWeight: 650,
                      color: 'var(--t-text)',
                      letterSpacing: '-0.01em',
                    }}
                  >
                    Bring a repo into Cortex
                  </span>
                  <span
                    style={{
                      display: 'block',
                      marginTop: 3,
                      fontSize: 10.5,
                      lineHeight: 1.45,
                      color: 'var(--t-text-faint)',
                    }}
                  >
                    Add a local Git repository with + and launch workspace flows from here.
                  </span>
                </span>
              </div>
            </div>
          ) : null}

          {!loading && !loadError ? (
            orderedRepos.map((repo) => (
              <RepoCard
                key={repo.id}
                repo={repo}
                workspaceNotice={workspaceNotice[repo.id] ?? null}
                onLaunchAgent={(targetRepo) => {
                  void launchIntoWorkspace(targetRepo).catch((error) => {
                    window.alert(error instanceof Error ? error.message : 'Unable to launch workspace agent.');
                  });
                }}
                onOpenWorkspace={openWorkspaceModal}
                onOpenGitHub={handleOpenGitHub}
                onRemove={setRemoveTarget}
                onSaveSetup={handleSaveSetup}
                onSelectSession={onSelectSession}
                onSelectPR={onSelectPR}
                onReviewPR={onReviewPR}
                activeSessionKey={activeSessionKey}
                onSelectBranch={(branch, repoPath) => {
                  // Future: switch conversation context to agent on this branch
                  // For now: could trigger file tree refresh for this branch
                }}
                agentsByBranch={agentBranchMap.get(repo.name)}
                activePorts={portsByRepo.get(repo.name)}
                expanded={expandedRepoId === repo.id}
                onToggle={() => setExpandedRepoId((current) => current === repo.id ? null : repo.id)}
                isActive={repo.localPath === activeRepoLocalPath}
                activeWorkspacePath={activeWorkspacePath}
              />
            ))
          ) : null}

        </div>
      ) : null}

      <GlassModal
        open={addOpen}
        onClose={resetAddModal}
        title="Add Repository"
        subtitle="First pass is local-folder only. Cortex validates the path, resolves the repo root, and records the default branch plus setup scaffold."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="add-repository-path" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Local folder path
          </label>
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
            <input
              id="add-repository-path"
              name="addRepositoryPath"
              value={repoPathInput}
              onChange={(event) => {
                setRepoPathInput(event.currentTarget.value);
                setValidationError(null);
                setValidationResult(null);
              }}
              placeholder="~/projects/cortex-ide"
              autoFocus
              style={{
                flex: 1,
                minHeight: 40,
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid var(--t-btn-secondary-border)',
                background: 'rgba(255, 255, 255, 0.55)',
                color: 'var(--t-text)',
                fontSize: 13,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => {
                void handleBrowseForRepo();
              }}
              disabled={validating || adding}
              style={{
                minHeight: 40,
                padding: '0 12px',
                borderRadius: 12,
                border: '1px solid var(--t-btn-secondary-border)',
                background: 'var(--t-panel-hover)',
                color: 'var(--t-text-secondary)',
                fontSize: 12,
                fontWeight: 600,
                cursor: validating || adding ? 'not-allowed' : 'pointer',
                opacity: validating || adding ? 0.45 : 1,
                fontFamily: '-apple-system, system-ui, sans-serif',
                whiteSpace: 'nowrap',
              }}
            >
              Browse…
            </button>
          </div>
        </div>

        {validationError ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(239, 68, 68, 0.18)',
              background: 'rgba(254, 242, 242, 0.82)',
              color: '#991b1b',
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{validationError}</span>
          </div>
        ) : null}

        {validationResult ? (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(34, 197, 94, 0.18)',
              background: 'rgba(240, 253, 244, 0.85)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 700,
                color: '#166534',
              }}
            >
              <CheckCircle2 size={14} strokeWidth={2} />
              Validation complete
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: '6px 10px', fontSize: 12 }}>
              <span style={{ color: 'var(--t-text-muted)' }}>Repo</span>
              <span style={{ color: 'var(--t-text)', fontWeight: 600 }}>{validationResult.name}</span>
              <span style={{ color: 'var(--t-text-muted)' }}>Path</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {shortenPath(validationResult.localPath)}
              </span>
              <span style={{ color: 'var(--t-text-muted)' }}>Branch</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                {validationResult.defaultBranch}
              </span>
              <span style={{ color: 'var(--t-text-muted)' }}>Remote</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {validationResult.remoteUrl ?? 'No origin remote'}
              </span>
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={handleValidate}
            disabled={validating || adding}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-panel-hover)',
              color: 'var(--t-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: validating || adding ? 'not-allowed' : 'pointer',
              opacity: validating || adding ? 0.45 : 1,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            {validating ? 'Validating…' : 'Validate'}
          </button>
          <button
            type="button"
            onClick={handleAddRepo}
            disabled={adding || validating}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(239, 68, 68, 0.2)',
              background: 'rgba(239, 68, 68, 0.08)',
              color: '#b91c1c',
              fontSize: 12,
              fontWeight: 700,
              cursor: adding || validating ? 'not-allowed' : 'pointer',
              opacity: adding || validating ? 0.45 : 1,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            {adding ? 'Adding…' : 'Add Repository'}
          </button>
        </div>
      </GlassModal>

      <GlassModal
        open={workspaceRepo !== null}
        onClose={closeWorkspaceModal}
        title={workspaceRepo ? `New Workspace · ${workspaceRepo.name}` : 'New Workspace'}
        subtitle="This reuses the existing worktree API. Cortex derives a worktree branch from the name below and returns the new workspace path after creation."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="create-workspace-name" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Workspace name
          </label>
          <input
            id="create-workspace-name"
            name="createWorkspaceName"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.currentTarget.value)}
            placeholder="repo-sync-20260317"
            style={{
              width: '100%',
              minHeight: 40,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'rgba(255, 255, 255, 0.55)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              outline: 'none',
            }}
          />
          <div
            style={{
              fontSize: 11,
              color: 'var(--t-text-muted)',
            }}
          >
            Branch preview
          </div>
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-divider-subtle)',
              background: 'rgba(255, 255, 255, 0.45)',
              color: 'var(--t-text)',
              fontSize: 12,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              wordBreak: 'break-all',
            }}
          >
            {branchPreview}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="create-workspace-base-branch" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Base branch
          </label>
          <input
            id="create-workspace-base-branch"
            name="createWorkspaceBaseBranch"
            value={workspaceBaseBranch}
            onChange={(event) => setWorkspaceBaseBranch(event.currentTarget.value)}
            placeholder="main"
            style={{
              width: '100%',
              minHeight: 40,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'rgba(255, 255, 255, 0.55)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              outline: 'none',
            }}
          />
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            cursor: 'pointer',
          }}
        >
          <input
            id="create-workspace-use-setup"
            name="createWorkspaceUseSetup"
            type="checkbox"
            checked={workspaceUseSetup}
            onChange={(event) => setWorkspaceUseSetup(event.currentTarget.checked)}
            style={{
              marginTop: 2,
              accentColor: '#ef4444',
            }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
              Run dependency setup
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: 'var(--t-text-muted)',
                lineHeight: 1.45,
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}
            >
              {workspaceRepo?.setup.installCommand ?? 'No install command detected'}
            </div>
          </div>
        </label>

        {workspaceRepo?.setup.runBuildOnCreateWorkspace || workspaceRepo?.setup.envMode !== 'copy' ? (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(37, 99, 235, 0.12)',
              background: 'rgba(239, 246, 255, 0.78)',
              fontSize: 11,
              lineHeight: 1.5,
              color: '#1d4ed8',
            }}
          >
            Saved repo setup includes env/build preferences. Env files now bootstrap into new workspaces automatically, and build preferences remain available for the next bootstrap pass.
          </div>
        ) : null}

        {workspaceError ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(239, 68, 68, 0.18)',
              background: 'rgba(254, 242, 242, 0.82)',
              color: '#991b1b',
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{workspaceError}</span>
          </div>
        ) : null}

        {workspaceResult ? (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(34, 197, 94, 0.18)',
              background: 'rgba(240, 253, 244, 0.85)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 700,
                color: '#166534',
              }}
            >
              <CheckCircle2 size={14} strokeWidth={2} />
              Workspace created
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: '6px 10px', fontSize: 12 }}>
              <span style={{ color: 'var(--t-text-muted)' }}>Branch</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {workspaceResult.branch}
              </span>
              <span style={{ color: 'var(--t-text-muted)' }}>Location</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {shortenPath(workspaceResult.path)}
              </span>
              <span style={{ color: 'var(--t-text-muted)' }}>Base</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                {workspaceResult.baseBranch}
              </span>
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={closeWorkspaceModal}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-panel-hover)',
              color: 'var(--t-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            {workspaceResult ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleCreateWorkspace}
            disabled={workspaceLoading}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(239, 68, 68, 0.2)',
              background: 'rgba(239, 68, 68, 0.08)',
              color: '#b91c1c',
              fontSize: 12,
              fontWeight: 700,
              cursor: workspaceLoading ? 'not-allowed' : 'pointer',
              opacity: workspaceLoading ? 0.45 : 1,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            {workspaceLoading ? 'Creating…' : workspaceResult ? 'Create Another' : 'Create Workspace'}
          </button>
        </div>
      </GlassModal>

      <GlassModal
        open={launchRepo !== null}
        onClose={closeLaunchModal}
        title={launchRepo ? `Launch Agent · ${launchRepo.name}` : 'Launch Agent'}
        subtitle="Open a new workspace CLI tab with the runtime you want. Add a prompt only if you want the agent to start immediately."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="launch-agent-runtime" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Runtime
          </label>
          <select
            id="launch-agent-runtime"
            name="launchAgentRuntime"
            value={launchRuntime}
            onChange={(event) => setLaunchRuntime(event.currentTarget.value as 'codex' | 'claude-code')}
            style={{
              width: '100%',
              minHeight: 40,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'rgba(255, 255, 255, 0.55)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '-apple-system, system-ui, sans-serif',
              outline: 'none',
            }}
          >
            <option value="codex">Codex</option>
            <option value="claude-code">Claude Code</option>
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="launch-agent-tab-label" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Tab label
          </label>
          <input
            id="launch-agent-tab-label"
            name="launchAgentTabLabel"
            value={launchTaskName}
            onChange={(event) => setLaunchTaskName(event.currentTarget.value)}
            placeholder="Optional"
            style={{
              width: '100%',
              minHeight: 40,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'rgba(255, 255, 255, 0.55)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              outline: 'none',
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="launch-agent-prompt" style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Initial prompt
          </label>
          <textarea
            id="launch-agent-prompt"
            name="launchAgentPrompt"
            value={launchPrompt}
            onChange={(event) => setLaunchPrompt(event.currentTarget.value)}
            rows={6}
            placeholder="Optional. Leave blank to open a ready session and steer it yourself."
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'rgba(255, 255, 255, 0.55)',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '-apple-system, system-ui, sans-serif',
              lineHeight: 1.5,
              outline: 'none',
              resize: 'vertical',
            }}
          />
        </div>

        <div
          style={{
            padding: 12,
            borderRadius: 12,
            border: '1px solid rgba(37, 99, 235, 0.12)',
            background: 'rgba(239, 246, 255, 0.78)',
            fontSize: 11,
            lineHeight: 1.5,
            color: '#1d4ed8',
          }}
        >
          This opens a new workspace CLI tab in the middle panel. Use the primary Launch Agent button for the fastest path, and use this sheet only when you want to choose the runtime or pre-seed the task prompt.
        </div>

        {launchError ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(239, 68, 68, 0.18)',
              background: 'rgba(254, 242, 242, 0.82)',
              color: '#991b1b',
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{launchError}</span>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={closeLaunchModal}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-panel-hover)',
              color: 'var(--t-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleLaunchAgent}
            disabled={launchLoading}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(239, 68, 68, 0.2)',
              background: 'rgba(239, 68, 68, 0.08)',
              color: '#b91c1c',
              fontSize: 12,
              fontWeight: 700,
              cursor: launchLoading ? 'not-allowed' : 'pointer',
              opacity: launchLoading ? 0.45 : 1,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            {launchLoading ? 'Launching…' : 'Launch Agent'}
          </button>
        </div>
      </GlassModal>

      <GlassModal
        open={removeTarget !== null}
        onClose={() => {
          setRemoveTarget(null);
          setRemoveError(null);
          setRemoveBusy(false);
        }}
        title={removeTarget ? `Remove ${removeTarget.name}` : 'Remove Repository'}
        subtitle="This only removes the repo from Cortex's registry. It does not delete the local repository or any existing worktrees."
        width={460}
      >
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.55,
            color: 'var(--t-text-muted)',
          }}
        >
          {removeTarget ? (
            <>
              <div style={{ color: 'var(--t-text)', fontWeight: 600 }}>{removeTarget.name}</div>
              <div style={{ marginTop: 6, fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {shortenPath(removeTarget.localPath)}
              </div>
            </>
          ) : null}
        </div>

        {removeError ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(239, 68, 68, 0.18)',
              background: 'rgba(254, 242, 242, 0.82)',
              color: '#991b1b',
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{removeError}</span>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={() => {
              setRemoveTarget(null);
              setRemoveError(null);
              setRemoveBusy(false);
            }}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid var(--t-btn-secondary-border)',
              background: 'var(--t-panel-hover)',
              color: 'var(--t-text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRemoveRepo}
            disabled={removeBusy}
            style={{
              minHeight: 36,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(239, 68, 68, 0.2)',
              background: 'rgba(239, 68, 68, 0.08)',
              color: '#b91c1c',
              fontSize: 12,
              fontWeight: 700,
              cursor: removeBusy ? 'not-allowed' : 'pointer',
              opacity: removeBusy ? 0.45 : 1,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            {removeBusy ? 'Removing…' : 'Remove Repository'}
          </button>
        </div>
      </GlassModal>
    </>
  );
}
