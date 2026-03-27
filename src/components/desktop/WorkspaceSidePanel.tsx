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
  GitBranch,
  GitPullRequest,
  MessageSquare,
  X,
} from 'lucide-react';
import type { ReviewChangedFile, ReviewPullRequestSummary, ReviewWorktreeSummary, WorkflowReviewSnapshot } from '@/lib/fleet/types';
import type { RepoReadiness } from '@/lib/repos/types';
import { BlueGlassActionButton, BlueGlassHoverCard } from './BlueGlassHoverCard';
import {
  formatCiCheckBatchInjection,
  formatCiCheckInjection,
  formatDeployBatchInjection,
  formatDeployContextInjection,
  formatReviewCommentBatchInjection,
  formatReviewCommentInjection,
  type AgentPanelChatInjectionPayload,
} from '@/lib/chat/injection';

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';
const THEME_ROW_HOVER = 'var(--t-hover)';

type WorkspacePanelTabId = 'changes' | 'files' | 'env' | 'review';

export interface WorkspaceSidePanelRepo {
  name: string;
  localPath: string;
  branch?: string | null;
  readiness?: RepoReadiness | null;
  remoteUrl?: string;
}

export type WorkspaceSidePanelView = 'blank' | 'diff' | 'review';

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
    resolvedRepo?: string;
    reviewComments: WorkspaceReviewComment[];
    issueComments: WorkspaceIssueComment[];
    workflowStage?: { key?: string; label?: string } | null;
    readiness?: RepoReadiness | null;
  };
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

function prStateLabel(pr: ReviewPullRequestSummary) {
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { label: 'Changes requested', color: '#b91c1c', bg: 'rgba(239, 68, 68, 0.08)' };
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return { label: 'Review pending', color: THEME_ACCENT, bg: THEME_ACCENT_SOFT };
  if (pr.isDraft) return { label: 'Draft', color: '#b45309', bg: 'rgba(245, 158, 11, 0.1)' };
  return { label: pr.state === 'OPEN' ? 'Open' : pr.state, color: 'var(--t-text-secondary)', bg: 'var(--t-divider-subtle)' };
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

function ReviewSection({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
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
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {title}
        </div>
        {actions ? <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>{actions}</div> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 8, paddingRight: 8 }}>
        {children}
      </div>
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

const ReviewTab = memo(function ReviewTab({
  repo,
  onInjectChatContext,
  onOpenPullRequest,
  onOpenDeploy,
}: {
  repo: WorkspaceSidePanelRepo | null;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload, repo: WorkspaceSidePanelRepo | null) => void;
  onOpenPullRequest?: (prNumber: number, repo?: string) => void;
  onOpenDeploy?: (project?: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<WorkflowReviewSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [checks, setChecks] = useState<WorkspaceReviewCheckRun[]>([]);
  const [checksLoading, setChecksLoading] = useState(false);
  const [hoveredRunId, setHoveredRunId] = useState<number | null>(null);
  const [hoveredRunRect, setHoveredRunRect] = useState<DOMRect | null>(null);
  const [runDetail, setRunDetail] = useState<WorkspaceReviewCheckRunDetail['run'] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deployments, setDeployments] = useState<WorkspaceDeploymentItem[]>([]);
  const [deployLoading, setDeployLoading] = useState(false);
  const [prDetail, setPrDetail] = useState<WorkspacePullRequestDetail | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [addedContextKeys, setAddedContextKeys] = useState<Record<string, boolean>>({});
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const workspaceQuery = useMemo(() => (
    repo?.localPath ? `workspace=${encodeURIComponent(repo.localPath)}` : ''
  ), [repo?.localPath]);
  const repoSlug = useMemo(() => repoSlugFromRemote(repo?.remoteUrl), [repo?.remoteUrl]);
  const reviewQuery = useMemo(() => {
    const parts = [workspaceQuery];
    if (repoSlug) parts.push(`repo=${encodeURIComponent(repoSlug)}`);
    return parts.filter(Boolean).length ? `?${parts.filter(Boolean).join('&')}` : '';
  }, [repoSlug, workspaceQuery]);

  useEffect(() => {
    let active = true;
    async function fetchReview() {
      setLoading(true);
      try {
        const res = await fetch(`/api/review/workspace${reviewQuery}`);
        if (!res.ok) throw new Error('Unable to load review state');
        const data = await res.json() as WorkflowReviewSnapshot;
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
  }, [reviewQuery]);

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

  const currentPullRequest = snapshot?.pullRequests[0] ?? null;

  useEffect(() => {
    const activePr = currentPullRequest;
    const slug = repoSlug;
    if (!activePr || !slug) {
      setPrDetail(null);
      return;
    }
    const prNumber = activePr.number;
    const repoParam = encodeURIComponent(slug);
    let active = true;
    async function fetchPullRequestDetail() {
      setCommentsLoading(true);
      try {
        const res = await fetch(`/api/panel/prs/${prNumber}?repo=${repoParam}`);
        const data = await res.json() as WorkspacePullRequestDetail;
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
  }, [currentPullRequest, repoSlug]);

  useEffect(() => {
    setAddedContextKeys({});
  }, [repo?.localPath, currentPullRequest?.number]);

  const injectPayload = useCallback((key: string, payload: AgentPanelChatInjectionPayload) => {
    if (!onInjectChatContext) return;
    onInjectChatContext(payload, repo);
    setAddedContextKeys((current) => ({ ...current, [key]: true }));
  }, [onInjectChatContext, repo]);

  const failedChecks = useMemo(
    () => checks.filter((check) => Boolean(check.conclusion) && check.conclusion.toLowerCase() !== 'success'),
    [checks],
  );
  const groupedChecks = useMemo(
    () => groupWorkflowRuns(checks, repo?.branch ?? null),
    [checks, repo?.branch],
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
    () => checks.find((check) => check.databaseId === hoveredRunId) ?? null,
    [checks, hoveredRunId],
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
      prNumber: currentPullRequest?.number ?? 0,
      repo: repoSlug ?? undefined,
      author: comment.user,
      body: comment.body,
      createdAt: comment.created_at,
    })),
    ...reviewComments.map((comment) => ({
      prNumber: currentPullRequest?.number ?? 0,
      repo: repoSlug ?? undefined,
      author: comment.author,
      body: comment.body,
      createdAt: comment.createdAt,
      path: comment.path,
      line: comment.line,
    })),
  ], [currentPullRequest?.number, issueComments, repoSlug, reviewComments]);

  if (loading && !snapshot) {
    return <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading review…</div>;
  }

  if (!snapshot) {
    return <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>No review surface available yet</div>;
  }

  return (
    <div className="cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto', paddingBottom: 10 }}>
      <ReviewSection
        title="Checks"
        actions={
          <>
            {failedChecks.length > 0 && currentPullRequest?.number && onInjectChatContext ? (
              <ContextActionChip
                icon={<MessageSquare size={11} strokeWidth={2} />}
                label={addedContextKeys[`checks:${currentPullRequest.number}`] ? 'Added' : 'Add failed to chat'}
                onClick={() => injectPayload(
                  `checks:${currentPullRequest.number}`,
                  formatCiCheckBatchInjection(
                    currentPullRequest.number,
                    repoSlug ?? undefined,
                    failedChecks.map((check) => ({
                      prNumber: currentPullRequest.number,
                      repo: repoSlug ?? undefined,
                      name: check.workflowName || check.displayTitle || 'Workflow',
                      status: check.status,
                      conclusion: check.conclusion,
                      detailsUrl: check.url,
                      startedAt: check.createdAt,
                      completedAt: check.updatedAt,
                    })),
                  ),
                )}
                disabled={Boolean(addedContextKeys[`checks:${currentPullRequest.number}`])}
              />
            ) : null}
          </>
        }
      >
        {checksLoading && checks.length === 0 ? (
          <EmptySectionState>Loading CI state…</EmptySectionState>
        ) : checks.length === 0 ? (
          <EmptySectionState>No recent CI runs yet.</EmptySectionState>
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
                          {!isPassed && currentPullRequest?.number && onInjectChatContext ? (
                            <ContextIconButton
                              icon={<MessageSquare size={11} strokeWidth={2} />}
                              label={addedContextKeys[key] ? 'Added to chat' : 'Add to chat'}
                              onClick={() => injectPayload(
                                key,
                                formatCiCheckInjection({
                                  prNumber: currentPullRequest.number,
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

      <ReviewSection
        title="Deploy"
        actions={
          <>
            {deployments.length > 0 && onInjectChatContext ? (
              <ContextActionChip
                icon={<MessageSquare size={11} strokeWidth={2} />}
                label={addedContextKeys[`deploys:${repo?.name ?? 'repo'}`] ? 'Added' : 'Add deploys'}
                onClick={() => injectPayload(
                  `deploys:${repo?.name ?? 'repo'}`,
                  formatDeployBatchInjection(
                    repo?.name,
                    repoSlug ?? undefined,
                    deployments.slice(0, 4).map((deployment) => ({
                      project: repo?.name,
                      repo: repoSlug ?? undefined,
                      environment: deployment.environment,
                      state: deployment.state,
                      url: deployment.url,
                      sha: deployment.sha,
                      createdAt: deployment.createdAt,
                      target: deployment.target,
                      commitMessage: deployment.commitMessage,
                    })),
                  ),
                )}
                disabled={Boolean(addedContextKeys[`deploys:${repo?.name ?? 'repo'}`])}
              />
            ) : null}
            {onOpenDeploy ? (
              <ContextActionChip
                icon={<ArrowRight size={11} strokeWidth={2} />}
                label="Open deploys"
                onClick={() => onOpenDeploy(repo?.name)}
              />
            ) : null}
          </>
        }
      >
        {deployLoading && deployments.length === 0 ? (
          <EmptySectionState>Loading deploy state…</EmptySectionState>
        ) : deployments.length === 0 ? (
          <EmptySectionState>No deploy information is available yet.</EmptySectionState>
        ) : (
          deployments.slice(0, 5).map((deployment) => {
            const key = `deploy:${deployment.id}`;
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {onInjectChatContext ? (
                      <ContextActionChip
                        icon={<MessageSquare size={11} strokeWidth={2} />}
                        label={addedContextKeys[key] ? 'Added' : 'Add'}
                        onClick={() => injectPayload(
                          key,
                          formatDeployContextInjection({
                            project: repo?.name,
                            repo: repoSlug ?? undefined,
                            environment: deployment.environment,
                            state: deployment.state,
                            url: deployment.url,
                            sha: deployment.sha,
                            createdAt: deployment.createdAt,
                            target: deployment.target,
                            commitMessage: deployment.commitMessage,
                          }),
                        )}
                        disabled={Boolean(addedContextKeys[key])}
                      />
                    ) : null}
                    {deployment.url ? (
                      <ContextActionChip
                        icon={<ExternalLink size={11} strokeWidth={2} />}
                        label="Open"
                        onClick={() => window.open(deployment.url, '_blank', 'noopener,noreferrer')}
                      />
                    ) : null}
                  </div>
                </div>
              </ContextObjectCard>
            );
          })
        )}
      </ReviewSection>

      <ReviewSection
        title="Comments"
        actions={
          <>
            {currentPullRequest && allCommentContexts.length > 0 && onInjectChatContext ? (
              <ContextActionChip
                icon={<MessageSquare size={11} strokeWidth={2} />}
                label={addedContextKeys[`comments:${currentPullRequest.number}`] ? 'Added' : 'Add comments'}
                onClick={() => injectPayload(
                  `comments:${currentPullRequest.number}`,
                  formatReviewCommentBatchInjection(
                    currentPullRequest.number,
                    repoSlug ?? undefined,
                    allCommentContexts,
                  ),
                )}
                disabled={Boolean(addedContextKeys[`comments:${currentPullRequest.number}`])}
              />
            ) : null}
            {currentPullRequest && repoSlug && onOpenPullRequest ? (
              <ContextActionChip
                icon={<ArrowRight size={11} strokeWidth={2} />}
                label="Open PR"
                onClick={() => onOpenPullRequest(currentPullRequest.number, repoSlug)}
              />
            ) : null}
          </>
        }
      >
        {commentsLoading && !prDetail ? (
          <EmptySectionState>Loading review feedback…</EmptySectionState>
        ) : !currentPullRequest ? (
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
                  return (
                    <ContextObjectCard key={comment.id} itemKind="issue-comment" itemId={String(comment.id)}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <MessageSquare size={14} strokeWidth={1.8} style={{ color: 'var(--t-text-secondary)', marginTop: 2, flexShrink: 0 }} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{comment.user}</div>
                            <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{formatAge(comment.created_at)}</span>
                          </div>
                          <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-secondary)', whiteSpace: 'pre-wrap' }}>
                            {comment.body.trim() || 'No comment body'}
                          </div>
                        </div>
                        {currentPullRequest && onInjectChatContext ? (
                          <ContextActionChip
                            icon={<MessageSquare size={11} strokeWidth={2} />}
                            label={addedContextKeys[key] ? 'Added' : 'Add'}
                            onClick={() => injectPayload(
                              key,
                              formatReviewCommentInjection({
                                prNumber: currentPullRequest.number,
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
                    <ContextObjectCard key={path} itemKind="review-thread" itemId={path}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <FileText size={14} strokeWidth={1.8} style={{ color: getFileIconColor(path.split('/').pop() || path), marginTop: 2, flexShrink: 0 }} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{path}</div>
                            <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{comments.length} comment{comments.length === 1 ? '' : 's'}</span>
                          </div>
                          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {comments.slice(0, 2).map((comment) => (
                              <div key={comment.id} style={{ fontSize: 11, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
                                <span style={{ fontWeight: 700, color: 'var(--t-text)' }}>{comment.author}</span>
                                {comment.line ? ` · L${comment.line}` : ''}
                                {` · ${formatAge(comment.createdAt)}`}
                                <div style={{ marginTop: 2, whiteSpace: 'pre-wrap' }}>{comment.body.trim() || 'No comment body'}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                        {currentPullRequest && onInjectChatContext ? (
                          <ContextActionChip
                            icon={<MessageSquare size={11} strokeWidth={2} />}
                            label={addedContextKeys[threadKey] ? 'Added' : 'Add thread'}
                            onClick={() => injectPayload(
                              threadKey,
                              formatReviewCommentBatchInjection(
                                currentPullRequest.number,
                                repoSlug ?? undefined,
                                comments.map((comment) => ({
                                  prNumber: currentPullRequest.number,
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

      <ReviewSection title="Review State">
        {currentPullRequest ? (
          <ContextObjectCard itemKind="pull-request" itemId={String(currentPullRequest.number)}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <GitPullRequest size={14} style={{ color: prStateLabel(currentPullRequest).color, marginTop: 2, flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>PR #{currentPullRequest.number}</div>
                  <span style={{ display: 'inline-flex', padding: '2px 7px', borderRadius: 999, background: prStateLabel(currentPullRequest).bg, color: prStateLabel(currentPullRequest).color, fontSize: 10, fontWeight: 700 }}>
                    {prDetail?.pr.workflowStage?.label ?? prStateLabel(currentPullRequest).label}
                  </span>
                </div>
                <div style={{ marginTop: 3, fontSize: 12, color: 'var(--t-text-secondary)' }}>{currentPullRequest.title}</div>
              </div>
            </div>
          </ContextObjectCard>
        ) : null}

        {snapshot.worktrees.length > 0 ? snapshot.worktrees.map((worktree) => {
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
        }) : (
          <EmptySectionState>No tracked workspaces are linked yet.</EmptySectionState>
        )}

        {snapshot.warnings && snapshot.warnings.length > 0 ? snapshot.warnings.map((warning, index) => (
          <ContextObjectCard key={warning} itemKind="warning" itemId={`warning-${index}`}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, color: '#92400e' }}>
              <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>{warning}</div>
            </div>
          </ContextObjectCard>
        )) : null}
      </ReviewSection>
    </div>
  );
});

export function WorkspaceSidePanel({
  view,
  repo,
  onClearView,
  onOpenFile,
  onInjectChatContext,
  onOpenPullRequest,
  onOpenDeploy,
}: {
  view: WorkspaceSidePanelView;
  repo: WorkspaceSidePanelRepo | null;
  onClearView: () => void;
  onOpenFile: (path: string, repo: WorkspaceSidePanelRepo | null) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload, repo: WorkspaceSidePanelRepo | null) => void;
  onOpenPullRequest?: (prNumber: number, repo?: string) => void;
  onOpenDeploy?: (project?: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<WorkspacePanelTabId>(() => view === 'review' ? 'review' : 'changes');

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
      </div>

      {activeTab === 'changes' ? <ChangesTab repo={repo} onOpenFile={onOpenFile} /> : null}
      {activeTab === 'files' ? <FilesTab repo={repo} mode="all" onOpenFile={onOpenFile} /> : null}
      {activeTab === 'env' ? <FilesTab repo={repo} mode="env" onOpenFile={onOpenFile} /> : null}
      {activeTab === 'review' ? (
        <ReviewTab
          repo={repo}
          onInjectChatContext={onInjectChatContext}
          onOpenPullRequest={onOpenPullRequest}
          onOpenDeploy={onOpenDeploy}
        />
      ) : null}
    </div>
  );
}
