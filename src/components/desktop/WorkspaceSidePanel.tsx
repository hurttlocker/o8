'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileEdit,
  FileMinus,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  GitCommit,
  GitBranch,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  X,
} from 'lucide-react';
import type { ReviewChangedFile, ReviewPullRequestSummary, ReviewWorktreeSummary, WorkflowReviewSnapshot } from '@/lib/fleet/types';
import type { RepoReadiness } from '@/lib/repos/types';
import { deriveWorkflowStage, describeWorkflowStage, workflowBadge } from '@/lib/workflows/status';
import { BlueGlassActionButton, BlueGlassHoverCard } from './BlueGlassHoverCard';
import { MarkdownBody } from './MarkdownBody';
import {
  formatCiCheckBatchInjection,
  formatCiCheckInjection,
  formatReviewCommentBatchInjection,
  formatReviewCommentInjection,
  type AgentPanelChatInjectionPayload,
} from '@/lib/chat/injection';

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';
const THEME_ROW_HOVER = 'var(--t-hover)';

type WorkspacePanelTabId = 'changes' | 'files' | 'env' | 'review' | 'git-log';

export interface WorkspaceSidePanelRepo {
  name: string;
  localPath: string;
  branch?: string | null;
  readiness?: RepoReadiness | null;
  remoteUrl?: string;
}

interface WorkspaceChatTargetOption {
  sessionKey: string;
  label: string;
  detail?: string | null;
}

export type WorkspaceSidePanelView = 'blank' | 'diff' | 'review' | 'git-log';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

interface WorkspaceReviewCheckRun {
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

interface WorkspaceReviewCheckRunDetail {
  run: {
    databaseId: number;
    displayTitle: string;
    event: string;
    headBranch: string;
    headSha: string;
    status: string;
    conclusion: string;
    createdAt: string;
    updatedAt: string;
    workflowName: string;
    url: string;
    pullRequests?: Array<{ number: number; url: string }>;
    jobs?: Array<{
      databaseId: number;
      name: string;
      status: string;
      conclusion: string;
      startedAt: string;
      completedAt: string;
      url: string;
      annotations: Array<{
        path: string;
        startLine: number;
        endLine: number;
        level: string;
        message: string;
        title: string;
        rawDetails: string;
        blobUrl: string;
      }>;
    }>;
    annotations?: Array<{
      path: string;
      startLine: number;
      endLine: number;
      level: string;
      message: string;
      title: string;
      rawDetails: string;
      blobUrl: string;
      jobName?: string;
      jobUrl?: string;
    }>;
  };
  logs?: string;
}

interface WorkspaceDeploymentItem {
  id: string;
  label: string;
  environment?: string;
  state: string;
  url?: string;
  sha?: string;
  createdAt?: string;
  target?: string;
  commitMessage?: string;
  source: 'vercel' | 'github';
}

interface WorkspaceIssueComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
}

interface WorkspaceReviewComment {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
  side: string;
  createdAt: string;
  state: string;
  diffHunk: string;
  inReplyTo: number | null;
}

interface WorkspacePullRequestDetail {
  pr: {
    number: number;
    title: string;
    state?: 'open' | 'closed' | 'merged';
    reviewDecision?: string | null;
    headRefName?: string | null;
    url?: string;
    resolvedRepo?: string;
    reviewComments: WorkspaceReviewComment[];
    issueComments: WorkspaceIssueComment[];
    workflowStage?: { key?: string; label?: string } | null;
    readiness?: RepoReadiness | null;
  };
}

interface WorkspaceResolvedPullRequest {
  number: number;
  title: string;
  state?: string;
  reviewDecision?: string | null;
  headRefName?: string | null;
  url?: string;
  isDraft?: boolean;
}

const FILE_NAME_COLORS: Record<string, string> = {
  'package.json': '#f59e0b',
  'tsconfig.json': '#3178c6',
  'next.config.js': '#111827',
  'next.config.ts': '#111827',
  'README.md': '#519aba',
  'CHANGELOG.md': '#519aba',
  '.env': '#ecd53f',
  '.env.local': '#ecd53f',
  '.gitignore': '#f05032',
  'CLAUDE.md': '#d97706',
  'AGENTS.md': '#d97706',
};

const FILE_ICON_COLORS: Record<string, string> = {
  '.ts': '#3178c6',
  '.tsx': '#3178c6',
  '.js': '#f1e05a',
  '.jsx': '#61dafb',
  '.json': '#f59e0b',
  '.md': '#519aba',
  '.css': '#ec4899',
  '.scss': '#ec4899',
  '.html': '#e34c26',
  '.yml': '#cb171e',
  '.yaml': '#cb171e',
  '.svg': '#f59e0b',
};

const FOLDER_COLORS: Record<string, string> = {
  src: '#42a5f5',
  app: '#ef5350',
  components: '#ab47bc',
  lib: '#26a69a',
  hooks: '#7e57c2',
  public: '#66bb6a',
  assets: '#ffa726',
  api: '#42a5f5',
  config: '#78909c',
  docs: '#42a5f5',
  scripts: '#78909c',
  '.github': '#6e5494',
};

function shortenPath(value: string) {
  const userPath = value.replace(/^\/Users\/[^/]+/, '~');
  if (userPath !== value) return userPath;
  return value.replace(/^\/home\/[^/]+/, '~');
}

function getFileIconColor(name: string) {
  const lower = name.toLowerCase();
  if (FILE_NAME_COLORS[lower]) return FILE_NAME_COLORS[lower];
  if (FILE_NAME_COLORS[name]) return FILE_NAME_COLORS[name];
  const ext = `.${name.split('.').pop()?.toLowerCase() ?? ''}`;
  return FILE_ICON_COLORS[ext] ?? 'var(--t-text-faint)';
}

function getFolderColor(name: string) {
  return FOLDER_COLORS[name.toLowerCase()] ?? '#42a5f5';
}

function repoSlugFromRemote(remoteUrl?: string) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

function normalizeBranchName(value?: string | null) {
  return value?.trim().replace(/^refs\/heads\//, '') || null;
}

function branchesMatch(left?: string | null, right?: string | null) {
  const normalizedLeft = normalizeBranchName(left);
  const normalizedRight = normalizeBranchName(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function formatAge(value?: string | number | null) {
  if (!value) return 'now';
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const diffMs = Date.now() - ms;
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.max(1, Math.round(diffMs / 60_000))}m ago`;
  if (diffMs < 86_400_000) return `${Math.max(1, Math.round(diffMs / 3_600_000))}h ago`;
  return `${Math.max(1, Math.round(diffMs / 86_400_000))}d ago`;
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Request failed: ${response.status}`);
    }
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}

function shortSha(value?: string | null) {
  return value ? value.slice(0, 7) : null;
}

function workflowRunTone(run: { status?: string | null; conclusion?: string | null }) {
  const conclusion = run.conclusion?.toLowerCase() ?? '';
  const passed = conclusion === 'success';
  const pending = !run.conclusion || run.status?.toLowerCase() !== 'completed';
  if (passed) {
    return {
      label: 'Passing',
      color: '#15803d',
      bg: 'rgba(34,197,94,0.10)',
      border: 'rgba(34,197,94,0.16)',
    };
  }
  if (pending) {
    return {
      label: 'Pending',
      color: '#b45309',
      bg: 'rgba(245,158,11,0.10)',
      border: 'rgba(245,158,11,0.18)',
    };
  }
  return {
    label: 'Failing',
    color: '#b91c1c',
    bg: 'rgba(239,68,68,0.10)',
    border: 'rgba(239,68,68,0.18)',
  };
}

interface WorkflowRunGroup {
  key: string;
  title: string;
  branch: string;
  updatedAt?: string;
  createdAt?: string;
  runs: WorkspaceReviewCheckRun[];
}

function groupWorkflowRuns(runs: WorkspaceReviewCheckRun[], fallbackBranch?: string | null): WorkflowRunGroup[] {
  const groups = new Map<string, WorkflowRunGroup>();

  for (const run of runs) {
    const title = run.displayTitle || run.workflowName || 'Workflow run';
    const branch = run.headBranch || fallbackBranch || 'branch';
    const key = `${title}::${branch}`;
    const existing = groups.get(key);
    if (existing) {
      existing.runs.push(run);
      const existingTs = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
      const runTs = new Date(run.updatedAt || run.createdAt || 0).getTime();
      if (runTs > existingTs) {
        existing.updatedAt = run.updatedAt;
        existing.createdAt = run.createdAt;
      }
    } else {
      groups.set(key, {
        key,
        title,
        branch,
        updatedAt: run.updatedAt,
        createdAt: run.createdAt,
        runs: [run],
      });
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      runs: [...group.runs].sort((left, right) => {
        const leftTone = workflowRunTone(left).label;
        const rightTone = workflowRunTone(right).label;
        const rank = (label: string) => label === 'Failing' ? 0 : label === 'Pending' ? 1 : 2;
        const leftRank = rank(leftTone);
        const rightRank = rank(rightTone);
        if (leftRank !== rightRank) return leftRank - rightRank;
        return (left.workflowName || left.displayTitle || '').localeCompare(right.workflowName || right.displayTitle || '');
      }),
    }))
    .sort((left, right) => {
      const leftTs = new Date(left.updatedAt || left.createdAt || 0).getTime();
      const rightTs = new Date(right.updatedAt || right.createdAt || 0).getTime();
      return rightTs - leftTs;
    });
}

function worktreeStateLabel(worktree: ReviewWorktreeSummary) {
  if (worktree.isCurrent) return 'Current';
  if (worktree.prunableReason) return 'Prunable';
  if (worktree.lockedReason) return 'Locked';
  if (worktree.isDetached) return 'Detached';
  return 'Ready';
}

function worktreeStateTone(worktree: ReviewWorktreeSummary) {
  if (worktree.isCurrent) return { bg: 'rgba(37, 99, 235, 0.08)', color: THEME_ACCENT };
  if (worktree.prunableReason) return { bg: 'rgba(239, 68, 68, 0.08)', color: '#b91c1c' };
  if (worktree.lockedReason) return { bg: 'rgba(245, 158, 11, 0.1)', color: '#b45309' };
  return { bg: 'var(--t-divider-subtle)', color: 'var(--t-text-secondary)' };
}

function prStateLabel(pr: { reviewDecision?: string | null; isDraft?: boolean; state?: string | null }) {
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { label: 'Changes requested', color: '#b91c1c', bg: 'rgba(239, 68, 68, 0.08)' };
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return { label: 'Review pending', color: THEME_ACCENT, bg: THEME_ACCENT_SOFT };
  if (pr.isDraft) return { label: 'Draft', color: '#b45309', bg: 'rgba(245, 158, 11, 0.1)' };
  return { label: !pr.state || pr.state === 'OPEN' ? 'Open' : pr.state, color: 'var(--t-text-secondary)', bg: 'var(--t-divider-subtle)' };
}

function WorkspaceDiffStatusIcon({ status }: { status: ReviewChangedFile['status'] | string }) {
  const color = status === 'added'
    ? '#22c55e'
    : status === 'deleted'
      ? '#ef4444'
      : status === 'modified'
        ? '#f59e0b'
        : status === 'renamed'
          ? '#8b5cf6'
          : 'var(--t-text-faint)';
  const size = 14;
  switch (status) {
    case 'added': return <FilePlus size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    case 'deleted': return <FileMinus size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    case 'modified': return <FileEdit size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
    default: return <FileText size={size} strokeWidth={1.8} style={{ color, flexShrink: 0 }} />;
  }
}

function PanelTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '6px 9px',
        borderRadius: 999,
        border: 'none',
        background: active ? 'var(--t-hover)' : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
        fontSize: 10,
        fontWeight: 700,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function ContextActionChip({
  label,
  onClick,
  icon,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 7px',
        borderRadius: 8,
        border: '1px solid var(--t-btn-secondary-border)',
        background: disabled ? 'var(--t-divider-subtle)' : 'var(--t-btn-secondary-bg)',
        color: disabled ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
        fontSize: 10,
        fontWeight: 700,
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {icon ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 12,
            height: 12,
            lineHeight: 0,
            color: disabled ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
      ) : null}
      {label}
    </button>
  );
}

function ContextHintBadge({
  label,
}: {
  label: string;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '4px 7px',
        borderRadius: 8,
        border: '1px solid var(--t-btn-secondary-border)',
        background: 'var(--t-divider-subtle)',
        color: 'var(--t-text-secondary)',
        fontSize: 10,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      <MessageSquare size={11} strokeWidth={2} />
      {label}
    </span>
  );
}

function ChatTargetSelector({
  options,
  selectedSessionKey,
  onSelect,
}: {
  options: WorkspaceChatTargetOption[];
  selectedSessionKey: string | null;
  onSelect: (sessionKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.sessionKey === selectedSessionKey) ?? options[0] ?? null;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  if (!selectedOption) {
    return null;
  }

  const showPicker = options.length > 1;

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => {
          if (!showPicker) return;
          setOpen((current) => !current);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          minHeight: 28,
          padding: '5px 8px',
          borderRadius: 8,
          border: '1px solid var(--t-btn-secondary-border)',
          background: 'var(--t-divider-subtle)',
          color: 'var(--t-text-secondary)',
          fontSize: 10,
          fontWeight: 700,
          cursor: showPicker ? 'pointer' : 'default',
          whiteSpace: 'nowrap',
        }}
      >
        <MessageSquare size={11} strokeWidth={2} />
        <span style={{ color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>To</span>
        <span style={{ color: 'var(--t-text)' }}>{selectedOption.label}</span>
        {showPicker ? <ChevronDown size={11} strokeWidth={2.2} style={{ color: 'var(--t-text-faint)' }} /> : null}
      </button>
      {showPicker && open ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 220,
            maxWidth: 280,
            padding: 6,
            borderRadius: 12,
            border: '1px solid var(--t-divider)',
            background: THEME_PANEL_GLASS,
            boxShadow: '0 14px 32px rgba(15, 23, 42, 0.18)',
            backdropFilter: 'blur(18px)',
            WebkitBackdropFilter: 'blur(18px)',
            zIndex: 30,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {options.map((option) => {
            const selected = option.sessionKey === selectedOption.sessionKey;
            return (
              <button
                key={option.sessionKey}
                type="button"
                onClick={() => {
                  onSelect(option.sessionKey);
                  setOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  width: '100%',
                  padding: '7px 8px',
                  borderRadius: 9,
                  border: 'none',
                  background: selected ? 'var(--t-hover)' : 'transparent',
                  color: 'var(--t-text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <MessageSquare size={12} strokeWidth={2} style={{ color: selected ? THEME_ACCENT : 'var(--t-text-faint)', marginTop: 1, flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>{option.label}</div>
                  {option.detail ? (
                    <div style={{ marginTop: 2, fontSize: 10, color: 'var(--t-text-muted)' }}>
                      {option.detail}
                    </div>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ContextIconButton({
  label,
  onClick,
  icon,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: 8,
        border: '1px solid var(--t-btn-secondary-border)',
        background: disabled ? 'var(--t-divider-subtle)' : 'var(--t-btn-secondary-bg)',
        color: disabled ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        flexShrink: 0,
        boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 12,
          height: 12,
          lineHeight: 0,
          color: disabled ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
    </button>
  );
}

function PrimaryActionButton({
  label,
  onClick,
  icon,
  disabled = false,
  tone = 'accent',
  prominent = false,
}: {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  tone?: 'accent' | 'success' | 'neutral';
  prominent?: boolean;
}) {
  const palette = tone === 'success'
    ? {
        background: 'rgba(34, 197, 94, 0.12)',
        border: 'rgba(34, 197, 94, 0.2)',
        color: '#15803d',
      }
    : tone === 'neutral'
      ? {
          background: 'var(--t-btn-secondary-bg)',
          border: 'var(--t-btn-secondary-border)',
          color: 'var(--t-text)',
        }
      : {
          background: THEME_ACCENT_SOFT,
          border: 'rgba(37, 99, 235, 0.18)',
          color: THEME_ACCENT,
        };
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
        minHeight: prominent ? 34 : 30,
        padding: prominent ? '8px 13px' : '7px 11px',
        borderRadius: 9,
        border: `1px solid ${palette.border}`,
        background: disabled ? 'var(--t-divider-subtle)' : palette.background,
        color: disabled ? 'var(--t-text-faint)' : palette.color,
        fontSize: prominent ? 12 : 11,
        fontWeight: 700,
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
        boxShadow: prominent && !disabled ? '0 6px 16px rgba(15, 23, 42, 0.08)' : 'none',
      }}
    >
      {icon ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12, lineHeight: 0 }}>
          {icon}
        </span>
      ) : null}
      {label}
    </button>
  );
}

function ReviewSection({
  title,
  actions,
  collapsible = false,
  open = true,
  onToggle,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section style={{ paddingTop: 4, paddingBottom: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '7px 10px 5px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {title}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {actions}
          {collapsible ? (
            <button
              type="button"
              onClick={onToggle}
              aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                borderRadius: 8,
                border: '1px solid var(--t-btn-secondary-border)',
                background: 'var(--t-btn-secondary-bg)',
                color: 'var(--t-text)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12, lineHeight: 0, color: 'var(--t-text-secondary)' }}>
                {open ? <ChevronDown size={12} strokeWidth={2.2} /> : <ChevronRight size={12} strokeWidth={2.2} />}
              </span>
            </button>
          ) : null}
        </div>
      </div>
      {open ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 8, paddingRight: 8 }}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

function ContextObjectCard({
  itemKind,
  itemId,
  children,
  style,
}: {
  itemKind: string;
  itemId: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      data-context-object="true"
      data-context-kind={itemKind}
      data-context-id={itemId}
      data-context-drag-ready="true"
      style={{
        borderRadius: 10,
        border: '1px solid var(--t-divider-subtle)',
        background: 'rgba(255, 255, 255, 0.03)',
        padding: '8px 10px',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function EmptySectionState({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 12,
        border: '1px dashed var(--t-divider-subtle)',
        color: 'var(--t-text-muted)',
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function TreeNode({
  node,
  changedFiles,
  changeMap,
  mode = 'all',
  depth = 0,
  onOpenFile,
}: {
  node: FileNode;
  changedFiles: Set<string>;
  changeMap?: Map<string, ReviewChangedFile>;
  mode?: 'all' | 'changes';
  depth?: number;
  onOpenFile: (path: string) => void;
}) {
  const hasChangedChild = node.type === 'dir' && hasChangedDescendant(node, changedFiles);
  const [open, setOpen] = useState(() => mode === 'changes' ? hasChangedChild || depth === 0 : depth === 0 || node.name === 'src');
  const isChanged = node.type === 'file' && changedFiles.has(node.path);
  const changeEntry = node.type === 'file' ? changeMap?.get(node.path) ?? null : null;

  if (node.type === 'file') {
    return (
      <button
        type="button"
        onClick={() => onOpenFile(node.path)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: `5px 12px 5px ${12 + depth * 14}px`,
          border: 'none',
          background: 'transparent',
          color: isChanged ? 'var(--t-text)' : 'var(--t-text-secondary)',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: 12,
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = THEME_ROW_HOVER; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        {mode === 'changes' && changeEntry ? (
          <WorkspaceDiffStatusIcon status={changeEntry.status} />
        ) : (
          <FileText size={13} strokeWidth={1.5} style={{ flexShrink: 0, color: isChanged ? THEME_ACCENT : getFileIconColor(node.name) }} />
        )}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
        {mode === 'changes' && changeEntry ? (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 700 }}>
            {(changeEntry.additions ?? 0) > 0 ? <span style={{ color: '#22c55e' }}>+{changeEntry.additions}</span> : null}
            {(changeEntry.deletions ?? 0) > 0 ? <span style={{ color: '#ef4444' }}>-{changeEntry.deletions}</span> : null}
          </span>
        ) : isChanged ? (
          <span style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: 999, background: THEME_ACCENT, flexShrink: 0 }} />
        ) : null}
      </button>
    );
  }

  const folderColor = getFolderColor(node.name);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: `5px 12px 5px ${12 + depth * 14}px`,
          border: 'none',
          background: 'transparent',
          color: 'var(--t-text)',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: 12,
          fontWeight: 600,
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = THEME_ROW_HOVER; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        {open ? <FolderOpen size={13} strokeWidth={1.6} style={{ color: folderColor, flexShrink: 0 }} /> : <Folder size={13} strokeWidth={1.6} style={{ color: folderColor, flexShrink: 0 }} />}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
        {open ? <ChevronDown size={11} style={{ color: 'var(--t-text-faint)', marginLeft: 'auto', flexShrink: 0 }} /> : <ChevronRight size={11} style={{ color: 'var(--t-text-faint)', marginLeft: 'auto', flexShrink: 0 }} />}
        {hasChangedChild && !open ? (
          <span style={{ width: 6, height: 6, borderRadius: 999, background: THEME_ACCENT, flexShrink: 0 }} />
        ) : null}
      </button>
      {open && node.children ? node.children.map((child) => (
        <TreeNode key={child.path} node={child} changedFiles={changedFiles} changeMap={changeMap} mode={mode} depth={depth + 1} onOpenFile={onOpenFile} />
      )) : null}
    </div>
  );
}

function hasChangedDescendant(node: FileNode, changedFiles: Set<string>): boolean {
  if (node.type === 'file') return changedFiles.has(node.path);
  return node.children?.some((child) => hasChangedDescendant(child, changedFiles)) ?? false;
}

function filterTreeToChanged(nodes: FileNode[], changedFiles: Set<string>): FileNode[] {
  return nodes
    .map((node) => {
      if (node.type === 'file') {
        return changedFiles.has(node.path) ? node : null;
      }
      const filteredChildren = filterTreeToChanged(node.children ?? [], changedFiles);
      if (filteredChildren.length === 0) return null;
      return { ...node, children: filteredChildren };
    })
    .filter((node): node is FileNode => node !== null);
}

function filterTreeToEnv(nodes: FileNode[]): FileNode[] {
  const envPattern = /^\.env|\.env\./;
  return nodes
    .map((node) => {
      if (node.type === 'file') {
        const name = node.name.toLowerCase();
        return envPattern.test(name) ? node : null;
      }
      const filteredChildren = filterTreeToEnv(node.children ?? []);
      if (filteredChildren.length === 0) return null;
      return { ...node, children: filteredChildren };
    })
    .filter((node): node is FileNode => node !== null);
}

const ChangesTab = memo(function ChangesTab({
  repo,
  onOpenFile,
}: {
  repo: WorkspaceSidePanelRepo | null;
  onOpenFile: (path: string, repo: WorkspaceSidePanelRepo | null) => void;
}) {
  const [files, setFiles] = useState<ReviewChangedFile[]>([]);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitLoading, setCommitLoading] = useState(false);
  const [actionToast, setActionToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const workspaceQuery = useMemo(() => (
    repo?.localPath ? `?workspace=${encodeURIComponent(repo.localPath)}` : ''
  ), [repo?.localPath]);

  const refreshFiles = useCallback(async () => {
    setLoading(true);
    try {
      const [diffRes, treeRes] = await Promise.all([
        fetch(`/api/review/workspace${workspaceQuery}`),
        fetch(`/api/panel/files${workspaceQuery}`),
      ]);
      if (!diffRes.ok) throw new Error('Failed to load workspace diff');
      if (!treeRes.ok) throw new Error('Failed to load workspace files');
      const diffData = await diffRes.json() as { changedFiles?: ReviewChangedFile[] };
      const treeData = await treeRes.json() as { tree?: FileNode[] };
      setFiles(Array.isArray(diffData.changedFiles) ? diffData.changedFiles : []);
      setTree(Array.isArray(treeData.tree) ? treeData.tree : []);
      setActionToast(null);
    } catch (error) {
      setFiles([]);
      setTree([]);
      setActionToast({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unable to load workspace diff',
      });
    } finally {
      setLoading(false);
    }
  }, [workspaceQuery]);

  useEffect(() => {
    void refreshFiles();
    const id = window.setInterval(() => { void refreshFiles(); }, 20_000);
    return () => window.clearInterval(id);
  }, [refreshFiles]);

  useEffect(() => {
    setCommitMsg('');
    setActionToast(null);
  }, [repo?.localPath]);

  const stageAndCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    setCommitLoading(true);
    setActionToast(null);
    try {
      const res = await fetch('/api/review/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMsg }),
      });
      const data = await res.json() as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Commit failed');
      setActionToast({ type: 'success', message: data.message || 'Committed changes' });
      setCommitMsg('');
      await refreshFiles();
    } catch (error) {
      setActionToast({ type: 'error', message: error instanceof Error ? error.message : 'Commit failed' });
    } finally {
      setCommitLoading(false);
    }
  }, [commitMsg, refreshFiles]);

  const totalAdditions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const totalDeletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const hasRepo = Boolean(repo?.localPath);
  const changedFileSet = useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const changeMap = useMemo(() => new Map(files.map((file) => [file.path, file] as const)), [files]);
  const visibleTree = useMemo(
    () => filterTreeToChanged(tree, changedFileSet),
    [tree, changedFileSet],
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderBottom: '1px solid var(--t-divider-subtle)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: '#22c55e' }}>+{totalAdditions}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#ef4444' }}>-{totalDeletions}</span>
        <span style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      </div>

      {files.length > 0 && hasRepo ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--t-divider-subtle)',
            flexShrink: 0,
          }}
        >
          <input
            id="workspace-commit-message"
            name="workspaceCommitMessage"
            aria-label="Workspace commit message"
            type="text"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(event) => setCommitMsg(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && commitMsg.trim()) {
                event.preventDefault();
                void stageAndCommit();
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              border: '1px solid var(--t-panel-border)',
              borderRadius: 8,
              padding: '7px 10px',
              fontSize: 12,
              outline: 'none',
              background: THEME_BG_CARD,
              color: 'var(--t-text)',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          />
          <button
            type="button"
            onClick={() => { void stageAndCommit(); }}
            disabled={!commitMsg.trim() || commitLoading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '7px 10px',
              borderRadius: 8,
              border: 'none',
              background: commitMsg.trim() ? '#16a34a' : 'var(--t-divider)',
              color: commitMsg.trim() ? '#fff' : 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 700,
              cursor: commitMsg.trim() ? 'pointer' : 'default',
              whiteSpace: 'nowrap',
            }}
          >
            <Check size={12} />
            {commitLoading ? 'Committing...' : 'Stage All + Commit'}
          </button>
        </div>
      ) : null}

      {actionToast ? (
        <div
          style={{
            padding: '8px 12px',
            fontSize: 11,
            fontWeight: 600,
            color: actionToast.type === 'success' ? '#15803d' : '#b91c1c',
            background: actionToast.type === 'success' ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
            borderBottom: '1px solid var(--t-divider-subtle)',
            flexShrink: 0,
          }}
        >
          {actionToast.message}
        </div>
      ) : null}

      <div className="cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading changes…</div>
        ) : visibleTree.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>
            {hasRepo ? 'Working tree clean' : 'Select a repo-scoped workspace to inspect changes'}
          </div>
        ) : (
          visibleTree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              changedFiles={changedFileSet}
              changeMap={changeMap}
              mode="changes"
              onOpenFile={(path) => onOpenFile(path, repo)}
            />
          ))
        )}
      </div>
    </div>
  );
});

const FilesTab = memo(function FilesTab({
  repo,
  mode,
  onOpenFile,
}: {
  repo: WorkspaceSidePanelRepo | null;
  mode: 'all' | 'env';
  onOpenFile: (path: string, repo: WorkspaceSidePanelRepo | null) => void;
}) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const workspaceQuery = useMemo(() => (
    repo?.localPath ? `?workspace=${encodeURIComponent(repo.localPath)}` : ''
  ), [repo?.localPath]);

  useEffect(() => {
    let active = true;
    async function fetchTree() {
      setLoading(true);
      try {
        const res = await fetch(`/api/panel/files${workspaceQuery}`);
        if (!res.ok) throw new Error('Unable to load file tree');
        const data = await res.json() as { tree?: FileNode[]; changedFiles?: string[] };
        if (!active) return;
        setTree(Array.isArray(data.tree) ? data.tree : []);
        setChangedFiles(new Set(Array.isArray(data.changedFiles) ? data.changedFiles : []));
      } catch {
        if (!active) return;
        setTree([]);
        setChangedFiles(new Set());
      } finally {
        if (active) setLoading(false);
      }
    }
    void fetchTree();
    const id = window.setInterval(() => { void fetchTree(); }, 30_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [workspaceQuery]);

  const visibleTree = useMemo(
    () => (mode === 'env' ? filterTreeToEnv(tree) : tree),
    [mode, tree],
  );

  return (
    <div className="cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto', paddingTop: 6, paddingBottom: 6 }}>
      {loading ? (
        <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading files…</div>
      ) : visibleTree.length === 0 ? (
        <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>
          {mode === 'env' ? 'No env files found' : 'No files found'}
        </div>
      ) : (
        visibleTree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            changedFiles={changedFiles}
            onOpenFile={(path) => onOpenFile(path, repo)}
          />
        ))
      )}
    </div>
  );
});

interface WorkspaceGitLogCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  refs: { type: string; name: string }[];
}

const GitLogTab = memo(function GitLogTab({
  repo,
  onSelectCommit,
}: {
  repo: WorkspaceSidePanelRepo | null;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
}) {
  const [commits, setCommits] = useState<WorkspaceGitLogCommit[]>([]);
  const [currentBranch, setCurrentBranch] = useState('main');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    async function fetchLog() {
      setLoading(true);
      try {
        const workspaceQuery = repo?.localPath ? `?workspace=${encodeURIComponent(repo.localPath)}` : '';
        const res = await fetch(`/api/panel/git-log${workspaceQuery}`);
        const data = await res.json() as { commits?: WorkspaceGitLogCommit[]; currentBranch?: string };
        if (!active) return;
        setCommits(Array.isArray(data.commits) ? data.commits : []);
        setCurrentBranch(data.currentBranch ?? 'main');
      } catch {
        if (!active) return;
        setCommits([]);
      } finally {
        if (active) setLoading(false);
      }
    }

    void fetchLog();
    const id = window.setInterval(() => { void fetchLog(); }, 45_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [repo?.localPath]);

  if (loading && commits.length === 0) {
    return <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading git history…</div>;
  }

  if (commits.length === 0) {
    return <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>No commits found</div>;
  }

  return (
    <div className="cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px 8px',
        borderBottom: '1px solid var(--t-divider-subtle)',
        position: 'sticky',
        top: 0,
        background: THEME_PANEL_GLASS,
        zIndex: 2,
      }}>
        <GitCommit size={14} style={{ color: 'var(--t-text-secondary)' }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>Git History</span>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '2px 7px',
          borderRadius: 999,
          background: THEME_ACCENT_SOFT,
          color: THEME_ACCENT,
          fontSize: 10,
          fontWeight: 700,
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}>
          {currentBranch}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--t-text-muted)' }}>
          {commits.length} commits
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', padding: '6px 0' }}>
        {commits.map((commit, index) => {
          const isHead = commit.refs.some((ref) => ref.type === 'head');
          return (
            <button
              key={commit.hash}
              type="button"
              onClick={() => onSelectCommit?.(commit.hash, repo?.localPath ? { workspace: repo.localPath } : undefined)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                width: '100%',
                padding: '9px 12px',
                border: 'none',
                background: 'transparent',
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--t-hover)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'transparent';
              }}
            >
              <div style={{
                width: 16,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                flexShrink: 0,
                position: 'relative',
                paddingTop: 3,
              }}>
                <span style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: isHead ? THEME_ACCENT : 'var(--t-text-faint)',
                  border: isHead ? `2px solid ${THEME_ACCENT_SOFT}` : '2px solid var(--t-divider-subtle)',
                  zIndex: 1,
                }} />
                {index < commits.length - 1 ? (
                  <span style={{
                    width: 1,
                    flex: 1,
                    minHeight: 22,
                    marginTop: 2,
                    background: 'var(--t-divider)',
                  }} />
                ) : null}
              </div>

              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--t-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    minWidth: 0,
                  }}>
                    {commit.subject}
                  </span>
                  {commit.refs.slice(0, 2).map((ref) => (
                    <span
                      key={`${commit.hash}:${ref.type}:${ref.name}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '1px 6px',
                        borderRadius: 999,
                        fontSize: 9,
                        fontWeight: 700,
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        flexShrink: 0,
                        ...(ref.type === 'head'
                          ? { color: THEME_ACCENT, background: THEME_ACCENT_SOFT }
                          : { color: 'var(--t-text-muted)', background: 'var(--t-divider-subtle)' }),
                      }}
                    >
                      {ref.name}
                    </span>
                  ))}
                </div>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  marginTop: 3,
                  fontSize: 10,
                  color: 'var(--t-text-muted)',
                  flexWrap: 'wrap',
                }}>
                  <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', color: 'var(--t-text-secondary)' }}>
                    {commit.shortHash}
                  </span>
                  <span>{commit.author}</span>
                  <span>{formatAge(commit.date)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});

const ReviewTab = memo(function ReviewTab({
  repo,
  preferredPullRequestNumber,
  compactReview,
  chatTargetLabel,
  chatTargets,
  selectedChatTargetKey,
  onSelectChatTarget,
  onInjectChatContext,
  onOpenPullRequest,
  onDeepReviewPullRequest,
  onExpandReviewRail,
}: {
  repo: WorkspaceSidePanelRepo | null;
  preferredPullRequestNumber?: number | null;
  compactReview?: boolean;
  chatTargetLabel?: string | null;
  chatTargets?: WorkspaceChatTargetOption[];
  selectedChatTargetKey?: string | null;
  onSelectChatTarget?: (sessionKey: string) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload, repo: WorkspaceSidePanelRepo | null) => void;
  onOpenPullRequest?: (prNumber: number, repo?: string) => void;
  onDeepReviewPullRequest?: (prNumber: number, repo?: string) => void;
  onExpandReviewRail?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<WorkflowReviewSnapshot | null>(null);
  const [repoSnapshot, setRepoSnapshot] = useState<WorkflowReviewSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [checks, setChecks] = useState<WorkspaceReviewCheckRun[]>([]);
  const [checksLoading, setChecksLoading] = useState(false);
  const [hoveredRunId, setHoveredRunId] = useState<number | null>(null);
  const [hoveredRunRect, setHoveredRunRect] = useState<DOMRect | null>(null);
  const [runDetail, setRunDetail] = useState<WorkspaceReviewCheckRunDetail['run'] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deployments, setDeployments] = useState<WorkspaceDeploymentItem[]>([]);
  const [deployLoading, setDeployLoading] = useState(false);
  const [expandedSection, setExpandedSection] = useState<'checks' | 'comments' | 'deploy' | null>('checks');
  const [prDetail, setPrDetail] = useState<WorkspacePullRequestDetail | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [selectedPullRequestNumber, setSelectedPullRequestNumber] = useState<number | null>(preferredPullRequestNumber ?? null);
  const [addedContextKeys, setAddedContextKeys] = useState<Record<string, boolean>>({});
  const [reviewActionLoading, setReviewActionLoading] = useState<'merge' | null>(null);
  const [reviewActionResult, setReviewActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [reviewReloadNonce, setReviewReloadNonce] = useState(0);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextResultTimerRef = useRef<number | null>(null);

  const workspaceQuery = useMemo(() => (
    repo?.localPath ? `workspace=${encodeURIComponent(repo.localPath)}` : ''
  ), [repo?.localPath]);
  const repoSlug = useMemo(() => repoSlugFromRemote(repo?.remoteUrl), [repo?.remoteUrl]);
  const reviewQuery = useMemo(() => {
    const parts = [workspaceQuery, 'strictBranch=1'];
    if (repoSlug) parts.push(`repo=${encodeURIComponent(repoSlug)}`);
    return parts.filter(Boolean).length ? `?${parts.filter(Boolean).join('&')}` : '';
  }, [repoSlug, workspaceQuery]);
  const repoReviewQuery = useMemo(() => {
    const parts = [workspaceQuery];
    if (repoSlug) parts.push(`repo=${encodeURIComponent(repoSlug)}`);
    return parts.filter(Boolean).length ? `?${parts.filter(Boolean).join('&')}` : '';
  }, [repoSlug, workspaceQuery]);

  useEffect(() => {
    let active = true;
    async function fetchReview() {
      setLoading(true);
      try {
        const data = await fetchJsonWithTimeout<WorkflowReviewSnapshot>(`/api/review/workspace${reviewQuery}`, 12000);
        if (!active) return;
        setSnapshot(data);
      } catch {
        if (!active) return;
        setSnapshot(null);
      } finally {
        if (active) setLoading(false);
      }
    }
    void fetchReview();
    const id = window.setInterval(() => { void fetchReview(); }, 30_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [reviewQuery, reviewReloadNonce]);

  useEffect(() => {
    let active = true;
    async function fetchRepoReview() {
      try {
        const data = await fetchJsonWithTimeout<WorkflowReviewSnapshot>(`/api/review/workspace${repoReviewQuery}`, 12000);
        if (!active) return;
        setRepoSnapshot(data);
      } catch {
        if (!active) return;
        setRepoSnapshot(null);
      }
    }
    void fetchRepoReview();
    const id = window.setInterval(() => { void fetchRepoReview(); }, 45_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [repoReviewQuery, reviewReloadNonce]);

  useEffect(() => {
    const slug = repoSlug;
    if (!slug) {
      setChecks([]);
      return;
    }
    const repoParam = encodeURIComponent(slug);
    let active = true;
    async function fetchChecks() {
      setChecksLoading(true);
      try {
        const res = await fetch(`/api/panel/ci?repo=${repoParam}`);
        const data = await res.json() as { runs?: WorkspaceReviewCheckRun[] };
        if (!active) return;
        const nextRuns = Array.isArray(data.runs) ? data.runs : [];
        nextRuns.sort((left, right) => {
          const leftFailed = Boolean(left.conclusion) && left.conclusion.toLowerCase() !== 'success';
          const rightFailed = Boolean(right.conclusion) && right.conclusion.toLowerCase() !== 'success';
          const leftPending = !left.conclusion || left.status?.toLowerCase() !== 'completed';
          const rightPending = !right.conclusion || right.status?.toLowerCase() !== 'completed';
          const leftRank = leftFailed ? 0 : leftPending ? 1 : 2;
          const rightRank = rightFailed ? 0 : rightPending ? 1 : 2;
          if (leftRank !== rightRank) return leftRank - rightRank;
          return new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime();
        });
        setChecks(nextRuns);
      } catch {
        if (!active) return;
        setChecks([]);
      } finally {
        if (active) setChecksLoading(false);
      }
    }
    void fetchChecks();
    const id = window.setInterval(() => { void fetchChecks(); }, 45_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [repoSlug]);

  useEffect(() => {
    let active = true;
    async function fetchDeploys() {
      setDeployLoading(true);
      try {
        const primary = await fetch(`/api/panel/deployments?project=${encodeURIComponent(repo?.name ?? '')}&limit=6`);
        const primaryData = await primary.json() as { deployments?: Array<{
          uid: string;
          name: string;
          url: string;
          state: string;
          created: number;
          ready?: number;
          target?: string;
          meta?: {
            githubCommitSha?: string;
            githubCommitMessage?: string;
          };
        }> };
        let nextDeploys: WorkspaceDeploymentItem[] = Array.isArray(primaryData.deployments)
          ? primaryData.deployments.map((deployment) => ({
              id: deployment.uid,
              label: deployment.name || repo?.name || 'Deploy',
              environment: deployment.target ?? undefined,
              state: deployment.state,
              url: deployment.url ? `https://${deployment.url}` : undefined,
              sha: shortSha(deployment.meta?.githubCommitSha) ?? undefined,
              createdAt: deployment.ready ? new Date(deployment.ready).toISOString() : new Date(deployment.created).toISOString(),
              target: deployment.target ?? undefined,
              commitMessage: deployment.meta?.githubCommitMessage,
              source: 'vercel',
            }))
          : [];

        if (!nextDeploys.length && repoSlug) {
          const fallback = await fetch(`/api/panel/deploys?repo=${encodeURIComponent(repoSlug)}`);
          const fallbackData = await fallback.json() as { deployments?: Array<{
            name?: string;
            environment?: string;
            sha?: string;
            createdAt?: string;
            state?: string;
          }> };
          nextDeploys = Array.isArray(fallbackData.deployments)
            ? fallbackData.deployments.map((deployment, index) => ({
                id: `${deployment.environment ?? 'deploy'}:${deployment.sha ?? index}`,
                label: deployment.name || repo?.name || 'Deploy',
                environment: deployment.environment,
                state: deployment.state ?? 'unknown',
                sha: shortSha(deployment.sha) ?? undefined,
                createdAt: deployment.createdAt,
                source: 'github',
              }))
            : [];
        }

        if (!active) return;
        nextDeploys.sort((left, right) => new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime());
        setDeployments(nextDeploys);
      } catch {
        if (!active) return;
        setDeployments([]);
      } finally {
        if (active) setDeployLoading(false);
      }
    }
    void fetchDeploys();
    const id = window.setInterval(() => { void fetchDeploys(); }, 60_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [repo?.name, repoSlug]);

  useEffect(() => {
    setSelectedPullRequestNumber(preferredPullRequestNumber ?? null);
  }, [preferredPullRequestNumber, repo?.localPath]);

  const currentBranch = normalizeBranchName(repo?.branch ?? snapshot?.branch ?? null);
  const pinnedPullRequestNumber = selectedPullRequestNumber ?? preferredPullRequestNumber ?? null;
  const repoPullRequests = useMemo(
    () => repoSnapshot?.pullRequests ?? snapshot?.pullRequests ?? [],
    [repoSnapshot?.pullRequests, snapshot?.pullRequests],
  );
  const branchPullRequest = useMemo(
    () => snapshot?.pullRequests.find((pullRequest) => branchesMatch(pullRequest.headRefName, currentBranch)) ?? null,
    [currentBranch, snapshot?.pullRequests],
  );
  const currentPullRequest = useMemo(
    () => {
      if (selectedPullRequestNumber) {
        return repoPullRequests.find((pullRequest) => pullRequest.number === selectedPullRequestNumber) ?? null;
      }
      return branchPullRequest;
    },
    [branchPullRequest, repoPullRequests, selectedPullRequestNumber],
  );
  const resolvedPullRequest = useMemo<WorkspaceResolvedPullRequest | null>(() => {
    if (currentPullRequest) {
      return currentPullRequest;
    }
    if (pinnedPullRequestNumber && prDetail?.pr.number === pinnedPullRequestNumber) {
      return {
        number: prDetail.pr.number,
        title: prDetail.pr.title,
        state: prDetail.pr.state,
        reviewDecision: prDetail.pr.reviewDecision ?? null,
        headRefName: prDetail.pr.headRefName ?? null,
        url: prDetail.pr.url,
      };
    }
    return null;
  }, [
    currentPullRequest,
    pinnedPullRequestNumber,
    prDetail?.pr.headRefName,
    prDetail?.pr.number,
    prDetail?.pr.reviewDecision,
    prDetail?.pr.state,
    prDetail?.pr.title,
    prDetail?.pr.url,
  ]);
  const chatTargetHint = chatTargetLabel?.trim() ? `To ${chatTargetLabel.trim()}` : null;
  const chatTargetControl = chatTargets && chatTargets.length > 0 && selectedChatTargetKey && onSelectChatTarget
    ? (
        <ChatTargetSelector
          options={chatTargets}
          selectedSessionKey={selectedChatTargetKey}
          onSelect={onSelectChatTarget}
        />
      )
    : chatTargetHint
      ? <ContextHintBadge label={chatTargetHint} />
      : null;
  const reviewBranch = useMemo(
    () => normalizeBranchName(resolvedPullRequest?.headRefName ?? currentBranch),
    [currentBranch, resolvedPullRequest?.headRefName],
  );
  const activePullRequest = resolvedPullRequest;
  const selectedPrIsOutsideCurrentBranch = Boolean(
    activePullRequest
    && currentBranch
    && activePullRequest.headRefName
    && !branchesMatch(activePullRequest.headRefName, currentBranch),
  );
  const activeReadiness = useMemo(
    () => (
      activePullRequest
        ? (selectedPrIsOutsideCurrentBranch ? null : (prDetail?.pr.readiness ?? null))
        : (repo?.readiness ?? null)
    ),
    [activePullRequest, prDetail?.pr.readiness, repo?.readiness, selectedPrIsOutsideCurrentBranch],
  );
  const alternatePullRequests = useMemo(() => {
    if (!repoPullRequests.length) return [] as ReviewPullRequestSummary[];
    return repoPullRequests.filter((pullRequest) => {
      if (activePullRequest && pullRequest.number === activePullRequest.number) {
        return false;
      }
      return true;
    });
  }, [activePullRequest, repoPullRequests]);

  useEffect(() => {
    const activePrNumber = currentPullRequest?.number ?? pinnedPullRequestNumber;
    const slug = repoSlug;
    if (!activePrNumber || !slug) {
      setPrDetail(null);
      return;
    }
    const repoParam = encodeURIComponent(slug);
    let active = true;
    async function fetchPullRequestDetail() {
      setCommentsLoading(true);
      try {
        const data = await fetchJsonWithTimeout<WorkspacePullRequestDetail>(`/api/panel/prs/${activePrNumber}?repo=${repoParam}`, 12000);
        if (!active) return;
        setPrDetail(data);
      } catch {
        if (!active) return;
        setPrDetail(null);
      } finally {
        if (active) setCommentsLoading(false);
      }
    }
    void fetchPullRequestDetail();
    const id = window.setInterval(() => { void fetchPullRequestDetail(); }, 45_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [currentPullRequest?.number, pinnedPullRequestNumber, repoSlug, reviewReloadNonce]);

  useEffect(() => {
    setAddedContextKeys({});
    setReviewActionResult(null);
    setReviewActionLoading(null);
  }, [repo?.localPath, resolvedPullRequest?.number]);

  const injectPayload = useCallback((key: string, payload: AgentPanelChatInjectionPayload) => {
    if (!onInjectChatContext) return;
    onInjectChatContext(payload, repo);
    setAddedContextKeys((current) => ({ ...current, [key]: true }));
    if (contextResultTimerRef.current) {
      window.clearTimeout(contextResultTimerRef.current);
    }
    setReviewActionResult({
      type: 'success',
      message: `Added to ${chatTargetLabel?.trim() || 'Chat'}.`,
    });
    contextResultTimerRef.current = window.setTimeout(() => {
      setReviewActionResult((current) => (
        current?.message === `Added to ${chatTargetLabel?.trim() || 'Chat'}.`
          ? null
          : current
      ));
    }, 3200);
  }, [chatTargetLabel, onInjectChatContext, repo]);

  useEffect(() => () => {
    if (contextResultTimerRef.current) {
      window.clearTimeout(contextResultTimerRef.current);
    }
  }, []);

  const scopedChecks = useMemo(() => {
    if (!reviewBranch) return checks;
    const exactMatches = checks.filter((check) => branchesMatch(check.headBranch, reviewBranch));
    return exactMatches;
  }, [checks, reviewBranch]);
  const failedChecks = useMemo(
    () => scopedChecks.filter((check) => Boolean(check.conclusion) && check.conclusion.toLowerCase() !== 'success'),
    [scopedChecks],
  );
  const pendingChecks = useMemo(
    () => scopedChecks.filter((check) => !check.conclusion || check.status?.toLowerCase() !== 'completed'),
    [scopedChecks],
  );
  const groupedChecks = useMemo(
    () => groupWorkflowRuns(scopedChecks, reviewBranch),
    [reviewBranch, scopedChecks],
  );

  const openRunHover = useCallback((runId: number, rect: DOMRect) => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    setHoveredRunId(runId);
    setHoveredRunRect(rect);
  }, []);

  const scheduleRunHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = setTimeout(() => {
      setHoveredRunId(null);
      setHoveredRunRect(null);
    }, 140);
  }, []);

  useEffect(() => {
    const slug = repoSlug;
    const runId = hoveredRunId;
    if (!slug || !runId) {
      setRunDetail(null);
      return;
    }
    const repoParam = encodeURIComponent(slug);
    let active = true;
    async function fetchRunDetail() {
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/panel/ci/${runId}?repo=${repoParam}`);
        const data = await res.json() as WorkspaceReviewCheckRunDetail;
        if (!active) return;
        setRunDetail(data.run ?? null);
      } catch {
        if (!active) return;
        setRunDetail(null);
      } finally {
        if (active) setDetailLoading(false);
      }
    }
    void fetchRunDetail();
    return () => {
      active = false;
    };
  }, [hoveredRunId, repoSlug]);

  const hoveredRun = useMemo(
    () => scopedChecks.find((check) => check.databaseId === hoveredRunId) ?? null,
    [hoveredRunId, scopedChecks],
  );
  const hoveredGroup = useMemo(
    () => groupedChecks.find((group) => group.runs.some((run) => run.databaseId === hoveredRunId)) ?? null,
    [groupedChecks, hoveredRunId],
  );

  const reviewComments = useMemo(() => prDetail?.pr.reviewComments ?? [], [prDetail?.pr.reviewComments]);
  const issueComments = useMemo(() => prDetail?.pr.issueComments ?? [], [prDetail?.pr.issueComments]);
  const inlineCommentsByPath = useMemo(() => {
    const grouped = new Map<string, WorkspaceReviewComment[]>();
    for (const comment of reviewComments) {
      const key = comment.path || 'inline-review';
      const current = grouped.get(key) ?? [];
      current.push(comment);
      grouped.set(key, current);
    }
    return Array.from(grouped.entries());
  }, [reviewComments]);
  const allCommentContexts = useMemo(() => [
    ...issueComments.map((comment) => ({
      prNumber: activePullRequest?.number ?? 0,
      repo: repoSlug ?? undefined,
      author: comment.user,
      body: comment.body,
      createdAt: comment.created_at,
    })),
    ...reviewComments.map((comment) => ({
      prNumber: activePullRequest?.number ?? 0,
      repo: repoSlug ?? undefined,
      author: comment.author,
      body: comment.body,
      createdAt: comment.createdAt,
      path: comment.path,
      line: comment.line,
    })),
  ], [activePullRequest?.number, issueComments, repoSlug, reviewComments]);
  const requestedChangesCount = useMemo(() => {
    const decision = activePullRequest?.reviewDecision?.toLowerCase() ?? '';
    return decision === 'changes_requested' ? 1 : 0;
  }, [activePullRequest?.reviewDecision]);
  const reviewStage = useMemo(
    () => {
      const workflowKey = selectedPrIsOutsideCurrentBranch ? null : (prDetail?.pr.workflowStage?.key ?? null);
      if (workflowKey) {
        return workflowBadge(workflowKey as Parameters<typeof workflowBadge>[0]);
      }
      return deriveWorkflowStage({
        prState: activePullRequest?.state,
        failedChecks: failedChecks.length,
        pendingChecks: pendingChecks.length,
        requestedChanges: requestedChangesCount,
        readinessState: activeReadiness?.state ?? null,
      });
    },
    [activePullRequest?.state, activeReadiness?.state, failedChecks.length, pendingChecks.length, prDetail?.pr.workflowStage?.key, requestedChangesCount, selectedPrIsOutsideCurrentBranch],
  );
  const reviewGuidance = useMemo(
    () => describeWorkflowStage({
      stage: reviewStage,
      prState: activePullRequest?.state,
      failedChecks: failedChecks.length,
      pendingChecks: pendingChecks.length,
      requestedChanges: requestedChangesCount,
      readinessState: activeReadiness?.state ?? null,
      readinessSummary: activeReadiness?.summary ?? null,
      readinessNextAction: activeReadiness?.nextAction ?? null,
    }),
    [activePullRequest?.state, activeReadiness?.nextAction, activeReadiness?.state, activeReadiness?.summary, failedChecks.length, pendingChecks.length, requestedChangesCount, reviewStage],
  );
  const reviewStageLabel = activePullRequest
    ? ((selectedPrIsOutsideCurrentBranch ? null : prDetail?.pr.workflowStage?.label) ?? reviewGuidance.stage?.label ?? prStateLabel(activePullRequest).label)
    : (pinnedPullRequestNumber ? 'Loading PR' : (activeReadiness?.label ?? 'No PR'));
  useEffect(() => {
    if ((failedChecks.length + pendingChecks.length) > 0) {
      setExpandedSection('checks');
      return;
    }
    if (allCommentContexts.length > 0) {
      setExpandedSection('comments');
      return;
    }
    if (activePullRequest?.state?.toLowerCase() === 'merged') {
      setExpandedSection('deploy');
      return;
    }
    setExpandedSection('checks');
  }, [activePullRequest?.number, activePullRequest?.state, allCommentContexts.length, failedChecks.length, pendingChecks.length]);
  const shouldShowDeployList = !activePullRequest || activePullRequest.state?.toLowerCase() === 'merged';
  const deploySummaryLabel = shouldShowDeployList
    ? (deployments.length > 0 ? `${deployments.length} deployment${deployments.length === 1 ? '' : 's'}` : deployLoading ? 'Loading…' : 'No deploys')
    : 'Post-merge';
  const compactChecksSummary = failedChecks.length > 0
    ? `${failedChecks.length} failing`
    : pendingChecks.length > 0
      ? `${pendingChecks.length} pending`
      : activePullRequest
        ? 'PR checks clean'
        : 'Repo runs available';
  const compactCommentsSummary = allCommentContexts.length > 0
    ? `${allCommentContexts.length} comment${allCommentContexts.length === 1 ? '' : 's'}`
    : 'No comments';
  const compactDeploySummary = shouldShowDeployList
    ? (deployments.length > 0 ? `${deployments.length} deployment${deployments.length === 1 ? '' : 's'}` : 'No deploys')
    : 'Post-merge only';
  const openBranchPullRequest = useCallback(() => {
    if (!repoSlug || !currentBranch) return;
    window.open(`https://github.com/${repoSlug}/compare/main...${currentBranch}?expand=1`, '_blank', 'noopener,noreferrer');
  }, [currentBranch, repoSlug]);
  const submitPullRequestAction = useCallback(async (action: 'merge') => {
    if (!activePullRequest || !repoSlug) return;
    setReviewActionLoading(action);
    setReviewActionResult(null);
    try {
      const res = await fetch(`/api/panel/prs/${activePullRequest.number}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, repo: repoSlug }),
      });
      const data = await res.json() as { error?: string; action?: string };
      if (!res.ok) {
        throw new Error(data.error || `Unable to ${action} pull request`);
      }
      setReviewActionResult({
        type: 'success',
        message: action === 'merge' ? `Merged PR #${activePullRequest.number}.` : 'Action completed.',
      });
      setReviewReloadNonce((value) => value + 1);
    } catch (error) {
      setReviewActionResult({
        type: 'error',
        message: error instanceof Error ? error.message : `Unable to ${action} pull request`,
      });
    } finally {
      setReviewActionLoading(null);
    }
  }, [activePullRequest, repoSlug]);
  const addFailedChecksToChat = useCallback(() => {
    if (!activePullRequest?.number || !failedChecks.length) return;
    injectPayload(
      `checks:${activePullRequest.number}`,
      formatCiCheckBatchInjection(
        activePullRequest.number,
        repoSlug ?? undefined,
        failedChecks.map((check) => ({
          prNumber: activePullRequest.number,
          repo: repoSlug ?? undefined,
          name: check.workflowName || check.displayTitle || 'Workflow',
          status: check.status,
          conclusion: check.conclusion,
          detailsUrl: check.url,
          startedAt: check.createdAt,
          completedAt: check.updatedAt,
        })),
      ),
    );
  }, [activePullRequest, failedChecks, injectPayload, repoSlug]);
  const addCommentsToChat = useCallback(() => {
    if (!activePullRequest?.number || !allCommentContexts.length) return;
    injectPayload(
      `comments:${activePullRequest.number}`,
      formatReviewCommentBatchInjection(
        activePullRequest.number,
        repoSlug ?? undefined,
        allCommentContexts,
      ),
    );
  }, [activePullRequest, allCommentContexts, injectPayload, repoSlug]);

  if (loading && !snapshot) {
    return <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading review…</div>;
  }

  if (!snapshot) {
    return <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>No review surface available yet</div>;
  }

  return (
    <div className="cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto', paddingBottom: 10 }}>
      <ReviewSection title="Review State">
        <ContextObjectCard itemKind="review-state" itemId={activePullRequest ? `pr:${activePullRequest.number}` : repo?.localPath ?? 'review-state'}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <GitPullRequest
                size={14}
                style={{
                  color: activePullRequest ? prStateLabel(activePullRequest).color : 'var(--t-text-faint)',
                  marginTop: 2,
                  flexShrink: 0,
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>
                    {activePullRequest ? `PR #${activePullRequest.number}` : (pinnedPullRequestNumber ? `PR #${pinnedPullRequestNumber}` : 'No PR attached')}
                  </div>
                  <span
                    style={{
                      display: 'inline-flex',
                      padding: '2px 7px',
                      borderRadius: 999,
                      background: reviewGuidance.stage?.background ?? 'var(--t-divider-subtle)',
                      color: reviewGuidance.stage?.color ?? 'var(--t-text-secondary)',
                      fontSize: 10,
                      fontWeight: 700,
                    }}
                  >
                    {reviewStageLabel}
                  </span>
                  {reviewBranch ? (
                    <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                      {reviewBranch}
                    </span>
                  ) : null}
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
                  {activePullRequest
                    ? activePullRequest.title
                    : pinnedPullRequestNumber
                      ? 'Loading selected pull request…'
                    : 'Open a pull request for this branch before treating review as a merge lane.'}
                </div>
                <div style={{ marginTop: 5, fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>
                  {activePullRequest
                    ? compactReview
                      ? 'Deep review is open in the center pane. Use this rail for merge and lightweight context.'
                      : reviewGuidance.detail
                    : pinnedPullRequestNumber
                      ? 'Keeping this lane pinned to the selected pull request while the details load.'
                    : activeReadiness?.summary ?? 'This branch is local-only right now.'}
                </div>
                {activePullRequest && !compactReview && reviewGuidance.nextAction ? (
                  <div style={{ marginTop: 5, fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>
                    {reviewGuidance.nextAction}
                  </div>
                ) : null}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {chatTargetControl && onInjectChatContext ? chatTargetControl : null}
              {!activePullRequest && repoSlug && currentBranch && currentBranch !== 'main' ? (
                <PrimaryActionButton
                  icon={<GitPullRequest size={11} strokeWidth={2.2} />}
                  label="Create PR"
                  onClick={openBranchPullRequest}
                />
              ) : null}
              {activePullRequest && reviewGuidance.mergeAllowed ? (
                <PrimaryActionButton
                  icon={<GitMerge size={11} strokeWidth={2.2} />}
                  label={reviewActionLoading === 'merge' ? 'Merging…' : 'Merge PR'}
                  onClick={() => { void submitPullRequestAction('merge'); }}
                  disabled={reviewActionLoading !== null}
                  tone="success"
                  prominent
                />
              ) : null}
              {activePullRequest && !reviewGuidance.mergeAllowed && failedChecks.length > 0 && onInjectChatContext ? (
                <PrimaryActionButton
                  icon={<MessageSquare size={11} strokeWidth={2.2} />}
                  label={addedContextKeys[`checks:${activePullRequest.number}`] ? 'Checks added' : 'Add failed checks'}
                  onClick={addFailedChecksToChat}
                  disabled={Boolean(addedContextKeys[`checks:${activePullRequest.number}`])}
                />
              ) : null}
              {activePullRequest && !reviewGuidance.mergeAllowed && failedChecks.length === 0 && allCommentContexts.length > 0 && onInjectChatContext ? (
                <PrimaryActionButton
                  icon={<MessageSquare size={11} strokeWidth={2.2} />}
                  label={addedContextKeys[`comments:${activePullRequest.number}`] ? 'Comments added' : 'Add comments'}
                  onClick={addCommentsToChat}
                  disabled={Boolean(addedContextKeys[`comments:${activePullRequest.number}`])}
                />
              ) : null}
              {activePullRequest && !compactReview && repoSlug && onOpenPullRequest ? (
                <PrimaryActionButton
                  icon={<ArrowRight size={11} strokeWidth={2.2} />}
                  label="Deep review"
                  onClick={() => {
                    if (onDeepReviewPullRequest) {
                      onDeepReviewPullRequest(activePullRequest.number, repoSlug);
                      return;
                    }
                    onOpenPullRequest(activePullRequest.number, repoSlug);
                  }}
                  tone="neutral"
                />
              ) : null}
            </div>

            {reviewActionResult ? (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: 10,
                  background: reviewActionResult.type === 'success' ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                  color: reviewActionResult.type === 'success' ? '#15803d' : '#b91c1c',
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {reviewActionResult.message}
              </div>
            ) : null}
          </div>
        </ContextObjectCard>

        {!compactReview && alternatePullRequests.length > 0 ? (
          <>
            <div style={{ padding: '0 2px', fontSize: 10, fontWeight: 700, color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {activePullRequest ? 'Other open pull requests' : 'Open pull requests'}
            </div>
            {alternatePullRequests.slice(0, 4).map((pullRequest) => (
              <ContextObjectCard key={pullRequest.number} itemKind="pull-request" itemId={`alternate-pr:${pullRequest.number}`} style={{ padding: '7px 8px', borderRadius: 9 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <GitPullRequest size={13} style={{ color: prStateLabel(pullRequest).color, marginTop: 2, flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>
                      PR #{pullRequest.number}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 11, color: 'var(--t-text-secondary)', lineHeight: 1.45 }}>
                      {pullRequest.title}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 10, color: 'var(--t-text-muted)', display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                      <span>{normalizeBranchName(pullRequest.headRefName) ?? pullRequest.headRefName}</span>
                      <span>{prStateLabel(pullRequest).label}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ContextIconButton
                      icon={<GitPullRequest size={11} strokeWidth={2} />}
                      label="Review here"
                      onClick={() => setSelectedPullRequestNumber(pullRequest.number)}
                    />
                    {repoSlug && onOpenPullRequest ? (
                      <ContextIconButton
                        icon={<ArrowRight size={11} strokeWidth={2} />}
                        label="Deep review"
                        onClick={() => {
                          if (onDeepReviewPullRequest) {
                            onDeepReviewPullRequest(pullRequest.number, repoSlug);
                            return;
                          }
                          onOpenPullRequest(pullRequest.number, repoSlug);
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              </ContextObjectCard>
            ))}
          </>
        ) : null}

        {!compactReview && !activePullRequest && snapshot.worktrees.length > 0 ? snapshot.worktrees.map((worktree) => {
          const tone = worktreeStateTone(worktree);
          return (
            <ContextObjectCard key={`${worktree.path}:${worktree.branch ?? 'detached'}`} itemKind="worktree" itemId={worktree.path}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <GitBranch size={14} style={{ color: tone.color, marginTop: 2, flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{worktree.branch ?? 'Detached worktree'}</div>
                    <span style={{ display: 'inline-flex', padding: '2px 7px', borderRadius: 999, background: tone.bg, color: tone.color, fontSize: 10, fontWeight: 700 }}>
                      {worktreeStateLabel(worktree)}
                    </span>
                  </div>
                  <div style={{ marginTop: 3, fontSize: 11, color: 'var(--t-text-muted)' }}>{worktree.path}</div>
                </div>
              </div>
            </ContextObjectCard>
          );
        }) : null}

        {!compactReview && !activePullRequest && snapshot.warnings && snapshot.warnings.length > 0 ? snapshot.warnings.map((warning, index) => (
          <ContextObjectCard key={warning} itemKind="warning" itemId={`warning-${index}`}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, color: '#92400e' }}>
              <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>{warning}</div>
            </div>
          </ContextObjectCard>
        )) : null}
      </ReviewSection>

      {compactReview && activePullRequest ? (
        <ReviewSection
          title="Companion"
          actions={onExpandReviewRail ? (
            <ContextActionChip
              icon={<ChevronDown size={11} strokeWidth={2} />}
              label="Open review rail"
              onClick={onExpandReviewRail}
            />
          ) : undefined}
        >
          <ContextObjectCard itemKind="review-companion" itemId={`companion:${activePullRequest.number}`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>Checks</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>{compactChecksSummary}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>Comments</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>{compactCommentsSummary}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>Deploy</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>{compactDeploySummary}</span>
              </div>
            </div>
          </ContextObjectCard>
        </ReviewSection>
      ) : null}

      {!compactReview ? (
      <ReviewSection
        title={activePullRequest ? 'PR Checks' : 'Checks'}
        collapsible
        open={expandedSection === 'checks'}
        onToggle={() => setExpandedSection((current) => current === 'checks' ? null : 'checks')}
        actions={
          <>
            {failedChecks.length > 0 && activePullRequest?.number && onInjectChatContext ? (
              <ContextActionChip
                icon={<MessageSquare size={11} strokeWidth={2} />}
                label={addedContextKeys[`checks:${activePullRequest.number}`] ? 'Added' : 'Add failed'}
                onClick={addFailedChecksToChat}
                disabled={Boolean(addedContextKeys[`checks:${activePullRequest.number}`])}
              />
            ) : null}
          </>
        }
      >
        {checksLoading && scopedChecks.length === 0 ? (
          <EmptySectionState>Loading CI state…</EmptySectionState>
        ) : scopedChecks.length === 0 ? (
          <EmptySectionState>
            {activePullRequest
              ? (checks.length > 0
                ? 'No CI runs are attached to this PR branch yet. Recent repo runs exist on other branches.'
                : 'No CI runs are attached to this PR yet.')
              : (reviewBranch ? `No recent CI runs for ${reviewBranch}.` : 'No recent CI runs yet.')}
          </EmptySectionState>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ padding: '2px 2px 0', fontSize: 10, fontWeight: 700, color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Recent runs
              </div>
              {groupedChecks.slice(0, 6).map((group) => {
                const failingCount = group.runs.filter((run) => workflowRunTone(run).label === 'Failing').length;
                const pendingCount = group.runs.filter((run) => workflowRunTone(run).label === 'Pending').length;
                const passingCount = group.runs.filter((run) => workflowRunTone(run).label === 'Passing').length;
                const primaryRun = group.runs.find((run) => workflowRunTone(run).label === 'Failing')
                  ?? group.runs.find((run) => workflowRunTone(run).label === 'Pending')
                  ?? group.runs[0];
                return (
                  <ContextObjectCard
                    key={group.key}
                    itemKind="check-group"
                    itemId={group.key}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 9,
                    }}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={(event) => openRunHover(primaryRun.databaseId, (event.currentTarget as HTMLDivElement).getBoundingClientRect())}
                      onMouseEnter={(event) => openRunHover(primaryRun.databaseId, (event.currentTarget as HTMLDivElement).getBoundingClientRect())}
                      onMouseMove={(event) => {
                        if (hoveredRunId === primaryRun.databaseId) {
                          setHoveredRunRect((event.currentTarget as HTMLDivElement).getBoundingClientRect());
                        }
                      }}
                      onMouseLeave={scheduleRunHoverClose}
                      onFocus={(event) => openRunHover(primaryRun.databaseId, (event.currentTarget as HTMLDivElement).getBoundingClientRect())}
                      onBlur={scheduleRunHoverClose}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          openRunHover(primaryRun.databaseId, (event.currentTarget as HTMLDivElement).getBoundingClientRect());
                        }
                      }}
                      style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, cursor: 'pointer' }}
                    >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>{group.title}</div>
                          <div style={{ marginTop: 3, fontSize: 10, color: 'var(--t-text-muted)', display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                            <span>{group.branch}</span>
                            <span>{formatAge(group.updatedAt || group.createdAt)}</span>
                            <span style={{ color: 'var(--t-text-faint)' }}>
                              {[
                                failingCount > 0 ? `${failingCount} fail` : null,
                                pendingCount > 0 ? `${pendingCount} pending` : null,
                                passingCount > 0 ? `${passingCount} pass` : null,
                              ].filter(Boolean).join(' • ')}
                            </span>
                          </div>
                        </div>
	                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
	                          {primaryRun?.url ? (
	                            <ContextIconButton
	                              icon={<ExternalLink size={11} strokeWidth={2} />}
                              label="Open run"
                              onClick={() => {
                                window.open(primaryRun.url, '_blank', 'noopener,noreferrer');
                              }}
	                            />
	                          ) : null}
	                        </div>
	                    </div>
	                  </ContextObjectCard>
	                );
              })}
            </div>
          </>
        )}
        {hoveredRun && hoveredRunRect ? (
          <BlueGlassHoverCard
            eyebrow="Checks"
            title={hoveredGroup?.title ?? hoveredRun.displayTitle ?? hoveredRun.workflowName ?? 'Workflow run'}
            subtitle={hoveredGroup?.branch ?? hoveredRun.headBranch ?? repo?.branch ?? 'branch'}
            anchorRect={hoveredRunRect}
            interactive
            onMouseEnter={() => {
              if (hoverCloseTimerRef.current) {
                clearTimeout(hoverCloseTimerRef.current);
                hoverCloseTimerRef.current = null;
              }
            }}
            onMouseLeave={scheduleRunHoverClose}
            footer={(
              <>
                <div />
                {hoveredRun.url ? (
                  <BlueGlassActionButton
                    icon={<ExternalLink size={12} strokeWidth={2} />}
                    label="Open Run"
                    onClick={() => window.open(hoveredRun.url, '_blank', 'noopener,noreferrer')}
                  />
                ) : null}
              </>
            )}
          >
            {!runDetail || detailLoading ? (
              <div style={{ fontSize: 12, color: 'rgba(15, 23, 42, 0.62)' }}>Loading run details…</div>
            ) : (
              <>
                {hoveredGroup ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {hoveredGroup.runs.map((run) => {
                      const tone = workflowRunTone(run);
                      const key = `check:${run.databaseId}`;
                      const isPassed = tone.label === 'Passing';
                      return (
                        <div
                          key={run.databaseId}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 8px',
                            borderRadius: 10,
                            background: 'rgba(255,255,255,0.28)',
                          }}
                        >
                          <span style={{ color: tone.color, fontWeight: 700 }}>
                            {tone.label === 'Passing' ? '✓' : tone.label === 'Pending' ? '○' : '✗'}
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(15, 23, 42, 0.82)' }}>
                              {run.workflowName || 'CI'}
                            </div>
                            <div style={{ marginTop: 2, fontSize: 10, color: tone.color }}>{tone.label}</div>
                          </div>
                          {!isPassed && activePullRequest?.number && onInjectChatContext ? (
                            <ContextIconButton
                              icon={<MessageSquare size={11} strokeWidth={2} />}
                              label={addedContextKeys[key] ? 'Added to chat' : 'Add to chat'}
                              onClick={() => injectPayload(
                                key,
                                formatCiCheckInjection({
                                  prNumber: activePullRequest.number,
                                  repo: repoSlug ?? undefined,
                                  name: run.workflowName || run.displayTitle || 'Workflow',
                                  status: run.status,
                                  conclusion: run.conclusion,
                                  detailsUrl: run.url,
                                  startedAt: run.createdAt,
                                  completedAt: run.updatedAt,
                                }),
                              )}
                              disabled={Boolean(addedContextKeys[key])}
                            />
                          ) : null}
                          {run.url ? (
                            <ContextIconButton
                              icon={<ExternalLink size={11} strokeWidth={2} />}
                              label="Open run"
                              onClick={() => window.open(run.url, '_blank', 'noopener,noreferrer')}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {runDetail.jobs && runDetail.jobs.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(15, 23, 42, 0.52)' }}>
                      Jobs
                    </div>
                    {runDetail.jobs.slice(0, 5).map((job) => {
                      const tone = workflowRunTone(job);
                      return (
                        <div
                          key={job.databaseId}
                          style={{
                            padding: '6px 8px',
                            borderRadius: 10,
                            background: 'rgba(255,255,255,0.28)',
                            fontSize: 11,
                            color: 'rgba(15, 23, 42, 0.78)',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ color: tone.color, fontWeight: 700 }}>{tone.label === 'Passing' ? '✓' : tone.label === 'Pending' ? '○' : '✗'}</span>
                            <div style={{ fontWeight: 700 }}>{job.name}</div>
                            <span style={{ color: tone.color, fontSize: 10 }}>{tone.label}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {runDetail.annotations && runDetail.annotations.length > 0 ? (
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
                    {runDetail.annotations[0]?.path}
                    {runDetail.annotations[0]?.startLine ? `:${runDetail.annotations[0].startLine}` : ''}
                    {' • '}
                    {runDetail.annotations[0]?.message || runDetail.annotations[0]?.title || runDetail.annotations[0]?.rawDetails}
                  </div>
                ) : null}
              </>
            )}
          </BlueGlassHoverCard>
        ) : null}
      </ReviewSection>
      ) : null}

      {!compactReview ? (
      <ReviewSection
        title="Comments"
        collapsible
        open={expandedSection === 'comments'}
        onToggle={() => setExpandedSection((current) => current === 'comments' ? null : 'comments')}
        actions={
          <>
            {activePullRequest && allCommentContexts.length > 0 && onInjectChatContext ? (
              <ContextActionChip
                icon={<MessageSquare size={11} strokeWidth={2} />}
                label={addedContextKeys[`comments:${activePullRequest.number}`] ? 'Added' : 'Add comments'}
                onClick={addCommentsToChat}
                disabled={Boolean(addedContextKeys[`comments:${activePullRequest.number}`])}
              />
            ) : null}
          </>
        }
      >
        {commentsLoading && !prDetail ? (
          <EmptySectionState>Loading review feedback…</EmptySectionState>
        ) : !activePullRequest ? (
          <EmptySectionState>No pull request is attached to this branch yet.</EmptySectionState>
        ) : issueComments.length === 0 && reviewComments.length === 0 ? (
          <EmptySectionState>No review comments need action right now.</EmptySectionState>
        ) : (
          <>
            {issueComments.length > 0 ? (
              <>
                <div style={{ padding: '0 2px', fontSize: 10, fontWeight: 700, color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>General</div>
                {issueComments.slice(0, 4).map((comment) => {
                  const key = `issue-comment:${comment.id}`;
                  const isBot = /\[bot\]$/i.test(comment.user);
                  return (
                    <ContextObjectCard
                      key={comment.id}
                      itemKind="issue-comment"
                      itemId={String(comment.id)}
                      style={{ padding: '7px 8px', borderRadius: 9 }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <MessageSquare size={13} strokeWidth={1.8} style={{ color: 'var(--t-text-secondary)', marginTop: 2, flexShrink: 0 }} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>{comment.user}</div>
                            {isBot ? (
                              <span style={{
                                display: 'inline-flex',
                                padding: '1px 6px',
                                borderRadius: 999,
                                background: 'var(--t-hover)',
                                color: 'var(--t-text-faint)',
                                fontSize: 8,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                              }}>
                                Bot
                              </span>
                            ) : null}
                            <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{formatAge(comment.created_at)}</span>
                          </div>
                          <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 10, background: 'var(--t-hover)' }}>
                            <MarkdownBody text={comment.body.trim() || 'No comment body'} compact />
                          </div>
                        </div>
                        {activePullRequest && onInjectChatContext ? (
                          <ContextActionChip
                            icon={<MessageSquare size={11} strokeWidth={2} />}
                            label={addedContextKeys[key] ? 'Added' : 'Add'}
                            onClick={() => injectPayload(
                              key,
                              formatReviewCommentInjection({
                                prNumber: activePullRequest.number,
                                repo: repoSlug ?? undefined,
                                author: comment.user,
                                body: comment.body,
                                createdAt: comment.created_at,
                              }),
                            )}
                            disabled={Boolean(addedContextKeys[key])}
                          />
                        ) : null}
                      </div>
                    </ContextObjectCard>
                  );
                })}
              </>
            ) : null}

            {inlineCommentsByPath.length > 0 ? (
              <>
                <div style={{ padding: '8px 2px 0', fontSize: 10, fontWeight: 700, color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Inline Review</div>
                {inlineCommentsByPath.slice(0, 6).map(([path, comments]) => {
                  const threadKey = `review-thread:${path}`;
                  return (
                    <ContextObjectCard
                      key={path}
                      itemKind="review-thread"
                      itemId={path}
                      style={{ padding: '7px 8px', borderRadius: 9 }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <FileText size={13} strokeWidth={1.8} style={{ color: getFileIconColor(path.split('/').pop() || path), marginTop: 2, flexShrink: 0 }} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>{path}</div>
                            <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{comments.length} comment{comments.length === 1 ? '' : 's'}</span>
                          </div>
                          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {comments.slice(0, 2).map((comment) => (
                              <div key={comment.id} style={{ fontSize: 10, color: 'var(--t-text-secondary)', lineHeight: 1.45 }}>
                                <span style={{ fontWeight: 700, color: 'var(--t-text)' }}>{comment.author}</span>
                                {comment.line ? ` · L${comment.line}` : ''}
                                {` · ${formatAge(comment.createdAt)}`}
                                <div style={{ marginTop: 4, padding: '6px 8px', borderRadius: 10, background: 'var(--t-hover)' }}>
                                  <MarkdownBody text={comment.body.trim() || 'No comment body'} compact />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                        {activePullRequest && onInjectChatContext ? (
                          <ContextActionChip
                            icon={<MessageSquare size={11} strokeWidth={2} />}
                            label={addedContextKeys[threadKey] ? 'Added' : 'Add thread'}
                            onClick={() => injectPayload(
                              threadKey,
                              formatReviewCommentBatchInjection(
                                activePullRequest.number,
                                repoSlug ?? undefined,
                                comments.map((comment) => ({
                                  prNumber: activePullRequest.number,
                                  repo: repoSlug ?? undefined,
                                  author: comment.author,
                                  body: comment.body,
                                  createdAt: comment.createdAt,
                                  path: comment.path,
                                  line: comment.line,
                                })),
                              ),
                            )}
                            disabled={Boolean(addedContextKeys[threadKey])}
                          />
                        ) : null}
                      </div>
                    </ContextObjectCard>
                  );
                })}
              </>
            ) : null}
          </>
        )}
      </ReviewSection>
      ) : null}

      {!compactReview ? (
      <ReviewSection
        title="Deploy"
        collapsible
        open={expandedSection === 'deploy'}
        onToggle={() => setExpandedSection((current) => current === 'deploy' ? null : 'deploy')}
        actions={<span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{deploySummaryLabel}</span>}
      >
        {!shouldShowDeployList ? (
          <EmptySectionState>Deploy becomes relevant after this pull request is merged.</EmptySectionState>
        ) : null}
        {shouldShowDeployList ? deployLoading && deployments.length === 0 ? (
          <EmptySectionState>Loading deploy state…</EmptySectionState>
        ) : deployments.length === 0 ? (
          <EmptySectionState>No deploy information is available yet.</EmptySectionState>
        ) : (
          deployments.slice(0, 5).map((deployment) => {
            const healthy = /ready|success/i.test(deployment.state);
            const pending = /queued|building|pending|in_progress/i.test(deployment.state);
            const tone = healthy
              ? { color: '#15803d', bg: 'rgba(34,197,94,0.10)' }
              : pending
                ? { color: '#b45309', bg: 'rgba(245,158,11,0.10)' }
                : { color: '#b91c1c', bg: 'rgba(239,68,68,0.10)' };
            return (
              <ContextObjectCard key={deployment.id} itemKind="deploy" itemId={deployment.id}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span style={{ display: 'inline-flex', width: 20, height: 20, borderRadius: 999, alignItems: 'center', justifyContent: 'center', background: tone.bg, color: tone.color, flexShrink: 0 }}>
                    {healthy ? <CheckCircle2 size={12} strokeWidth={2.2} /> : pending ? <Clock size={12} strokeWidth={2.2} /> : <Globe size={12} strokeWidth={2.2} />}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{deployment.label}</div>
                      <span style={{ display: 'inline-flex', padding: '2px 7px', borderRadius: 999, background: tone.bg, color: tone.color, fontSize: 10, fontWeight: 700 }}>
                        {deployment.state}
                      </span>
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--t-text-muted)' }}>
                      {deployment.environment ? <span>{deployment.environment}</span> : null}
                      {deployment.sha ? <span>{deployment.sha}</span> : null}
                      {deployment.createdAt ? <span>{formatAge(deployment.createdAt)}</span> : null}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, justifyContent: 'flex-end' }}>
                    {deployment.url ? (
                      <ContextIconButton
                        icon={<ExternalLink size={11} strokeWidth={2} />}
                        label="Open deploy"
                        onClick={() => window.open(deployment.url, '_blank', 'noopener,noreferrer')}
                      />
                    ) : null}
                  </div>
                </div>
              </ContextObjectCard>
            );
          })
        ) : null}
      </ReviewSection>
      ) : null}
    </div>
  );
});

export function WorkspaceSidePanel({
  view,
  repo,
  onClearView,
  onOpenFile,
  preferredPullRequestNumber,
  compactReview,
  chatTargetLabel,
  chatTargets,
  selectedChatTargetKey,
  onSelectChatTarget,
  onInjectChatContext,
  onOpenPullRequest,
  onDeepReviewPullRequest,
  onExpandReviewRail,
  onSelectCommit,
}: {
  view: WorkspaceSidePanelView;
  repo: WorkspaceSidePanelRepo | null;
  onClearView: () => void;
  onOpenFile: (path: string, repo: WorkspaceSidePanelRepo | null) => void;
  preferredPullRequestNumber?: number | null;
  compactReview?: boolean;
  chatTargetLabel?: string | null;
  chatTargets?: WorkspaceChatTargetOption[];
  selectedChatTargetKey?: string | null;
  onSelectChatTarget?: (sessionKey: string) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload, repo: WorkspaceSidePanelRepo | null) => void;
  onOpenPullRequest?: (prNumber: number, repo?: string) => void;
  onDeepReviewPullRequest?: (prNumber: number, repo?: string) => void;
  onExpandReviewRail?: () => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
}) {
  const [activeTab, setActiveTab] = useState<WorkspacePanelTabId>(() => (
    view === 'review'
      ? 'review'
      : view === 'git-log'
        ? 'git-log'
        : 'changes'
  ));

  if (view === 'blank') {
    return (
      <div
        aria-label="Workspace side panel"
        style={{
          flex: 1,
          background: 'var(--t-bg-gradient)',
        }}
      />
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: THEME_PANEL_GLASS,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderBottom: '1px solid var(--t-divider)',
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{repo?.name ?? 'Workspace'}</div>
          <div style={{ marginTop: 2, fontSize: 11, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {repo ? shortenPath(repo.localPath) : 'Workspace side panel'}
          </div>
        </div>
        <button
          type="button"
          onClick={onClearView}
          title="Clear workspace panel"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 8,
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <X size={12} />
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 10px',
          borderBottom: '1px solid var(--t-divider-subtle)',
          flexShrink: 0,
        }}
      >
        <PanelTab active={activeTab === 'changes'} label="Changes" onClick={() => setActiveTab('changes')} />
        <PanelTab active={activeTab === 'files'} label="All Files" onClick={() => setActiveTab('files')} />
        <PanelTab active={activeTab === 'env'} label="Env" onClick={() => setActiveTab('env')} />
        <PanelTab active={activeTab === 'review'} label="Review" onClick={() => setActiveTab('review')} />
        <PanelTab active={activeTab === 'git-log'} label="Git Log" onClick={() => setActiveTab('git-log')} />
      </div>

      {activeTab === 'changes' ? <ChangesTab repo={repo} onOpenFile={onOpenFile} /> : null}
      {activeTab === 'files' ? <FilesTab repo={repo} mode="all" onOpenFile={onOpenFile} /> : null}
      {activeTab === 'env' ? <FilesTab repo={repo} mode="env" onOpenFile={onOpenFile} /> : null}
      {activeTab === 'review' ? (
        <ReviewTab
          repo={repo}
          preferredPullRequestNumber={preferredPullRequestNumber}
          compactReview={compactReview}
          chatTargetLabel={chatTargetLabel}
          chatTargets={chatTargets}
          selectedChatTargetKey={selectedChatTargetKey}
          onSelectChatTarget={onSelectChatTarget}
          onInjectChatContext={onInjectChatContext}
          onOpenPullRequest={onOpenPullRequest}
          onDeepReviewPullRequest={onDeepReviewPullRequest}
          onExpandReviewRail={onExpandReviewRail}
        />
      ) : null}
      {activeTab === 'git-log' ? <GitLogTab repo={repo} onSelectCommit={onSelectCommit} /> : null}
    </div>
  );
}
