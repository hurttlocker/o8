'use client';
/* eslint-disable @typescript-eslint/no-unused-vars -- registry section retains dormant callbacks during workspace tooling rollout */

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
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
import { appendOpenClawBetaQuery, readOpenClawBetaEnabled, subscribeOpenClawBetaEnabled } from '@/lib/connectors/openclaw-beta';
import { FOCUS_REPO_SETUP_EVENT, type FocusRepoSetupDetail } from '@/lib/desktop/events';

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

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_ACCENT_SOFT_STRONG = 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.14))';
const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
const THEME_ACCENT_RING = 'var(--t-accent-ring, rgba(37, 99, 235, 0.15))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';

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
      return { background: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.16)', color: '#15803d' };
    case 'needs_setup':
      return { background: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.18)', color: '#b45309' };
    case 'blocked':
      return { background: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.18)', color: '#b91c1c' };
    default:
      return { background: 'var(--t-divider-subtle)', border: 'var(--t-panel-border)', color: 'var(--t-text-secondary)' };
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
            padding: '16px 18px 14px',
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
            padding: 18,
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
              padding: '14px 18px 18px',
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
  sessionKey: string;
  color: string;
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
  if (detail.checksStatus === 'pending') return { label: 'checks pending', color: '#d97706' };
  if (detail.reviewDecision === 'CHANGES_REQUESTED') return { label: 'changes requested', color: '#dc2626' };
  if (detail.reviewDecision === 'REVIEW_REQUIRED') return { label: 'review pending', color: '#2563eb' };
  return { label: 'merge ready', color: '#16a34a' };
}

function RepoCard({
  repo,
  workspaceNotice,
  onLaunchAgent,
  onOpenLaunchOptions,
  onOpenGitHub,
  onRemove,
  onSaveSetup,
  onSelectPR,
  onSelectBranch,
  agentsByBranch,
  activePorts,
  expanded,
  onToggle,
  isActive = false,
}: {
  repo: RepoRegistryEntry;
  workspaceNotice: WorkspaceCreateResult | null;
  onLaunchAgent: (repo: RepoRegistryEntry) => void;
  onOpenLaunchOptions: (repo: RepoRegistryEntry) => void;
  onOpenGitHub: (repo: RepoRegistryEntry) => void;
  onRemove: (repo: RepoRegistryEntry) => void;
  onSaveSetup: (repoId: string, setup: RepoSetupConfig) => Promise<void>;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onSelectBranch?: (branch: string, repoPath: string) => void;
  agentsByBranch?: Map<string, BranchAgent[]>;
  activePorts?: number[];
  expanded: boolean;
  onToggle: () => void;
  isActive?: boolean;
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
  const [branchMenuOpen, setBranchMenuOpen] = useState<string | null>(null);
  const [branchDeleting, setBranchDeleting] = useState<string | null>(null);
  const [branchDeleteConfirm, setBranchDeleteConfirm] = useState<string | null>(null);
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
  const hoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      setBranchMenuOpen(null);
      refreshBranches();
    } catch { /* silent */ }
    finally { setBranchDeleting(null); }
  }, [repo.localPath, refreshBranches]);

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
    } catch (err) {
      setNewBranchError(err instanceof Error ? err.message : 'Failed');
    } finally { setNewBranchCreating(false); }
  }, [newBranchName, newBranchWorktree, repo.localPath, repo.defaultBranch, refreshBranches]);

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

  const cardBackground = isActive
    ? 'linear-gradient(180deg, var(--t-panel) 0%, var(--t-panel-translucent) 100%)'
    : expanded
      ? 'linear-gradient(180deg, var(--t-panel-translucent) 0%, var(--t-bg-card, rgba(148, 163, 184, 0.08)) 100%)'
      : 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
  const cardBorder = isActive
    ? `1px solid ${THEME_ACCENT_BORDER}`
    : expanded
      ? '1px solid var(--t-divider-strong)'
      : '1px solid var(--t-panel-border)';
  const compactLayout = cardWidth > 0 && cardWidth < 320;

  const currentBadge = isActive ? (
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
  const portsBadge = activePorts && activePorts.length > 0 ? (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: compactLayout ? '1px 5px' : '1px 6px',
      borderRadius: 999,
      background: 'rgba(34,197,94,0.06)',
      border: '1px solid rgba(34,197,94,0.12)',
      flexShrink: 0,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: '#22c55e',
        animation: 'agentCardPulse 2s ease-in-out infinite',
      }} />
      <span style={{
        fontSize: 10, fontWeight: 600, color: '#16a34a',
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
        boxShadow: compactLayout ? `0 6px 16px ${THEME_ACCENT_RING}` : `0 8px 20px ${THEME_ACCENT_RING}`,
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
        padding: compactLayout ? '2px 7px' : '2px 8px',
        borderRadius: 999,
        background: repoReadinessPalette(repo.readiness.state).background,
        border: `1px solid ${repoReadinessPalette(repo.readiness.state).border}`,
        color: repoReadinessPalette(repo.readiness.state).color,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
      title={repo.readiness.summary}
    >
      {repo.readiness.label}
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
        width: 30,
        height: 30,
        borderRadius: 10,
        border: menuOpen ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)',
        background: menuOpen
          ? THEME_ACCENT_SOFT
          : THEME_BG_CARD,
        color: menuOpen ? THEME_ACCENT : 'var(--t-text-secondary)',
        cursor: 'pointer',
        flexShrink: 0,
        boxShadow: menuOpen
          ? `0 8px 18px ${THEME_ACCENT_RING}`
          : '0 4px 10px rgba(15, 23, 42, 0.08)',
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
        borderRadius: 18,
        border: cardBorder,
        background: cardBackground,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        boxShadow: isActive
          ? `0 18px 34px ${THEME_ACCENT_RING}`
          : expanded
            ? 'var(--t-panel-shadow)'
            : '0 8px 18px rgba(15, 23, 42, 0.08)',
        overflow: 'hidden',
      }}
    >
      {/* Compact header row — Conductor style */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: compactLayout ? 8 : 0,
          padding: compactLayout ? '11px 12px 10px' : '12px 14px',
          cursor: 'pointer',
        }}
        onClick={onToggle}
        onMouseEnter={(event) => schedulePreviewHover(event.currentTarget as HTMLDivElement, event.clientX, event.clientY)}
        onMouseLeave={closePreviewHover}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
          }}
        >
          <span style={{ color: 'var(--t-text-muted)', flexShrink: 0, display: 'flex' }}>
            {expanded ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {repo.name}
          </span>
          {!compactLayout ? currentBadge : null}
          {!compactLayout ? portsBadge : null}
          {!compactLayout ? readinessBadge : null}
          {!compactLayout ? prBadge : null}
          {!compactLayout ? mergeRiskBadge : null}
          {!compactLayout ? branchBadge : null}
          {menuTrigger}
        </div>

        {compactLayout ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
              paddingLeft: 22,
            }}
          >
            {currentBadge}
            {portsBadge}
            {readinessBadge}
            {prBadge}
            {branchBadge}
          </div>
        ) : null}
      </div>

      {hoveringHeader && (prPreviewLoading || prPreview.length > 0) ? (
        <BlueGlassHoverCard
          eyebrow="Open Pull Request"
          title={prPreviewLoading ? `Checking ${repo.name}…` : `PR #${prPreview[0].number} • ${prPreview[0].title}`}
          subtitle={prPreviewLoading
            ? 'Looking for active merge work on this repo.'
            : `${prPreview[0].author.login} wants to merge ${prPreview[0].headRefName} into ${repo.defaultBranch}.`}
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
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <BlueGlassMetricPill label="Review" value={prPreview[0].reviewDecision || 'pending'} color="#1d4ed8" />
                <BlueGlassMetricPill
                  label="Files"
                  value={String(prPreview[0].changedFiles)}
                  color="rgba(15,23,42,0.78)"
                />
                <BlueGlassMetricPill label="Risk" value={mergeRisk.label} color={mergeRisk.color} />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {onSelectPR ? (
                  <BlueGlassActionButton
                    icon={<GitPullRequest size={12} strokeWidth={2} />}
                    label="Review"
                    onClick={() => onSelectPR(prPreview[0].number, githubSlug ?? undefined)}
                  />
                ) : null}
                {prPreview[0].url ? (
                  <BlueGlassActionButton
                    icon={<ExternalLink size={12} strokeWidth={2} />}
                    label="Open PR"
                    onClick={() => window.open(prPreview[0].url, '_blank', 'noopener,noreferrer')}
                  />
                ) : null}
              </div>
            </>
          )}
        >
          {!prPreviewLoading ? (
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
                <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace' }}>{prPreview[0].headRefName}</span>
                <span>{formatRelativeTime(prPreview[0].createdAt)}</span>
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
              {prPreview.length > 1 ? (
                <div style={{ fontSize: 11, color: 'rgba(15, 23, 42, 0.62)' }}>
                  {prPreview.length - 1} more open PR{prPreview.length - 1 === 1 ? '' : 's'} on this repo.
                </div>
              ) : null}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8' }}>
                Next move: review the merge path before you steer more work into this repo.
              </div>
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
              { label: 'Launch with options', icon: <PlayCircle size={12} strokeWidth={2} />, action: () => { onOpenLaunchOptions(repo); setMenuOpen(false); } },
              { label: 'Settings', icon: <Settings2 size={12} strokeWidth={2} />, action: () => { setSettingsOpen((v) => !v); setMenuOpen(false); } },
              ...(githubUrl ? [{ label: 'Open on GitHub', icon: <ExternalLink size={12} strokeWidth={2} />, action: () => { onOpenGitHub(repo); setMenuOpen(false); } }] : []),
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
        <div style={{ padding: compactLayout ? '8px 12px 14px 24px' : '6px 14px 16px 44px' }}>
          {/* Primary actions row */}
          <div style={{ display: 'flex', alignItems: 'center', columnGap: compactLayout ? 10 : 12, rowGap: 8, flexWrap: compactLayout ? 'wrap' : 'nowrap', marginBottom: compactLayout ? 12 : 10 }}>
            <button
              type="button"
              onClick={() => onLaunchAgent(repo)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: THEME_ACCENT,
                fontSize: 11,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              <PlayCircle size={11} strokeWidth={2} />
              Launch agent
            </button>
            <button
              type="button"
              onClick={() => onOpenLaunchOptions(repo)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-muted)',
                fontSize: 11,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              <ChevronDown size={11} strokeWidth={2} />
              Options
            </button>
            {/* Dev server Run/Stop */}
            {repo.setup.devCommand ? (
              devServerRunning ? (<>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleStopDevServer(); }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    borderRadius: 6,
                    border: '1px solid rgba(239,68,68,0.15)',
                    background: 'rgba(239,68,68,0.05)',
                    color: '#dc2626',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}
                >
                  <Square size={8} strokeWidth={2.5} fill="#dc2626" />
                  Stop{devServerPort ? ` :${devServerPort}` : ''}
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setDevLogsOpen(v => !v); }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                  gap: 3,
                  padding: '2px 6px',
                  borderRadius: 6,
                  border: `1px solid ${devLogsOpen ? THEME_ACCENT_BORDER : 'var(--t-btn-secondary-border)'}`,
                  background: devLogsOpen ? THEME_ACCENT_SOFT : 'transparent',
                  color: devLogsOpen ? THEME_ACCENT : 'var(--t-text-muted)',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}
                >
                  Logs
                </button>
              </>) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleStartDevServer(); }}
                  disabled={devServerStarting}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    borderRadius: 6,
                    border: '1px solid rgba(34,197,94,0.15)',
                    background: 'rgba(34,197,94,0.05)',
                    color: '#16a34a',
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: devServerStarting ? 'wait' : 'pointer',
                    opacity: devServerStarting ? 0.6 : 1,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}
                >
                  <Play size={8} strokeWidth={2.5} fill="#16a34a" />
                  {devServerStarting ? 'Starting…' : 'Run dev'}
                </button>
              )
            ) : null}
            {!compactLayout ? <div style={{ flex: 1 }} /> : null}
            {!compactLayout ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(repo);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: '#b91c1c',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                <Trash2 size={11} strokeWidth={2} />
                Remove from Cortex
              </button>
            ) : null}
          </div>

          {/* Multi-agent conflict warning */}
          {(() => {
            if (!agentsByBranch) return null;
            const conflicts: { branch: string; agents: BranchAgent[] }[] = [];
            agentsByBranch.forEach((agents, branch) => {
              if (agents.length > 1) conflicts.push({ branch, agents });
            });
            if (conflicts.length === 0) return null;
            return (
              <div style={{
                margin: '4px 0',
                padding: '6px 8px',
                borderRadius: 8,
                background: 'rgba(239,68,68,0.03)',
                border: '1px solid rgba(239,68,68,0.10)',
              }}>
                {conflicts.map((c) => (
                  <div key={c.branch} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 10,
                    color: '#b91c1c',
                    fontWeight: 600,
                  }}>
                    <AlertCircle size={11} strokeWidth={2} />
                    <span>
                      {c.agents.map(a => a.name).join(' + ')} both on <span style={{
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        background: 'rgba(239,68,68,0.06)',
                        padding: '0 3px',
                        borderRadius: 3,
                      }}>{c.branch}</span>
                    </span>
                  </div>
                ))}
              </div>
            );
          })()}

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
          {workspaceNotice ? (
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

          {repo.readiness ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                marginBottom: 8,
                padding: '8px 10px',
                borderRadius: 10,
                border: `1px solid ${repoReadinessPalette(repo.readiness.state).border}`,
                background: repoReadinessPalette(repo.readiness.state).background,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: repoReadinessPalette(repo.readiness.state).color,
                  }}
                >
                  {repo.readiness.label}
                </span>
                {repo.readiness.currentBranch ? (
                  <span style={{ fontSize: 11, color: 'var(--t-text-secondary)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                    {repo.readiness.currentBranch}
                  </span>
                ) : null}
              </div>
              <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-secondary)' }}>
                {repo.readiness.summary}
              </div>
              {repo.readiness.nextAction ? (
                <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-muted)' }}>
                  {repo.readiness.nextAction}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Branch list — Apple-grade progressive disclosure */}
          <div style={{ marginTop: 6 }}>
            {branchesLoading ? (
              <div style={{ fontSize: 11, color: 'var(--t-text-faint)', padding: '4px 0' }}>Loading branches…</div>
            ) : branches.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {branches.map((branch) => {
                  const branchAgents = agentsByBranch?.get(branch.name) ?? [];
                  const visibleBranchAgents = compactLayout ? branchAgents.slice(0, 1) : branchAgents;
                  const hiddenAgentCount = compactLayout ? Math.max(0, branchAgents.length - visibleBranchAgents.length) : 0;
                  return (
                  <div key={branch.name}>
                  <div
                    onClick={() => {
                      if (!branch.current && !checkoutBusy) {
                        handleCheckout(branch.name);
                      }
                    }}
                  style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '5px 6px',
                      borderRadius: 8,
                      cursor: branch.current ? 'default' : checkoutBusy ? 'wait' : 'pointer',
                      transition: 'background 120ms ease',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = THEME_ACCENT_SOFT; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                  >
                    {/* Branch icon — colored by type */}
                    <GitBranch
                      size={12}
                      strokeWidth={2}
                      style={{
                        flexShrink: 0,
                        color: branch.current ? '#22c55e' : branch.isWorktree ? '#f59e0b' : 'var(--t-text-muted)',
                      }}
                    />
                    {/* Branch name */}
                    <span style={{
                      fontSize: 12,
                      fontWeight: branch.current ? 600 : 400,
                      color: branch.current ? 'var(--t-text)' : 'var(--t-text-secondary)',
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {branch.name}
                    </span>
                    {/* Current indicator */}
                    {branch.current ? (
                      <span style={{
                        fontSize: 9,
                        fontWeight: 700,
                        color: '#22c55e',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        flexShrink: 0,
                      }}>
                        current
                      </span>
                    ) : null}
                    {/* Agent indicators */}
                    {visibleBranchAgents.map((agent) => (
                      <span
                        key={agent.sessionKey}
                        title={agent.name}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          padding: '1px 5px',
                          borderRadius: 4,
                          background: `${agent.color}08`,
                          border: `1px solid ${agent.color}18`,
                          fontSize: 9,
                          fontWeight: 600,
                          color: agent.color,
                          flexShrink: 0,
                        }}
                      >
                        <span style={{
                          width: 5, height: 5, borderRadius: '50%',
                          background: agent.color,
                          flexShrink: 0,
                        }} />
                        {agent.name}
                      </span>
                    ))}
                    {hiddenAgentCount > 0 ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '1px 5px',
                          borderRadius: 4,
                          background: 'rgba(99, 102, 241, 0.08)',
                          border: '1px solid rgba(99, 102, 241, 0.12)',
                          fontSize: 9,
                          fontWeight: 700,
                          color: '#4f46e5',
                          flexShrink: 0,
                        }}
                      >
                        +{hiddenAgentCount}
                      </span>
                    ) : null}
                    {/* Worktree badge */}
                    {branch.isWorktree && !branch.current ? (
                      <span style={{
                        fontSize: 9,
                        fontWeight: 600,
                        color: '#f59e0b',
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: 'rgba(245, 158, 11, 0.08)',
                        flexShrink: 0,
                      }}>
                        worktree
                      </span>
                    ) : null}
                    {/* Stale badge */}
                    {branch.isStale ? (
                      <span style={{
                        fontSize: 9,
                        fontWeight: 600,
                        color: '#d97706',
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: 'rgba(217, 119, 6, 0.06)',
                        flexShrink: 0,
                      }}>
                        {branch.staleDays}d idle
                      </span>
                    ) : null}
                    {/* Disk size for worktrees */}
                    {!compactLayout && branch.diskSize ? (
                      <span style={{
                        fontSize: 9,
                        color: 'var(--t-text-faint)',
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        flexShrink: 0,
                      }}>
                        {branch.diskSize}
                      </span>
                    ) : null}
                    {/* Ahead/behind */}
                    {!compactLayout && (branch.ahead > 0 || branch.behind > 0) ? (
                      <span style={{
                        fontSize: 9,
                        fontWeight: 600,
                        color: 'var(--t-text-faint)',
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        flexShrink: 0,
                      }}>
                        {branch.ahead > 0 ? `↑${branch.ahead}` : ''}{branch.behind > 0 ? `↓${branch.behind}` : ''}
                      </span>
                    ) : null}
                    {/* Commit age */}
                    <span style={{
                      fontSize: 10,
                      color: branch.isStale ? '#d97706' : 'var(--t-text-faint)',
                      flexShrink: 0,
                    }}>
                      {branch.lastCommitAge}
                    </span>
                    {/* Open PR button — on feature branches with commits ahead */}
                    {!compactLayout && !branch.current && branch.name !== repo.defaultBranch && branch.ahead > 0 ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const ghUrl = githubUrlFromRemote(repo.remoteUrl);
                          if (ghUrl) {
                            window.open(`${ghUrl}/compare/${branch.name}?expand=1`, '_blank');
                          }
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          padding: '1px 6px',
                          borderRadius: 4,
                          border: `1px solid ${THEME_ACCENT_BORDER}`,
                          background: THEME_ACCENT_SOFT,
                          color: THEME_ACCENT,
                          fontSize: 9,
                          fontWeight: 600,
                          cursor: 'pointer',
                          flexShrink: 0,
                        }}
                        title={`Open PR for ${branch.name}`}
                      >
                        PR
                      </button>
                    ) : null}
                    {/* Overflow menu — not on current/protected */}
                    {!branch.current ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setBranchMenuOpen(branchMenuOpen === branch.name ? null : branch.name);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 24,
                          height: 24,
                          borderRadius: 8,
                          border: branchMenuOpen === branch.name ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)',
                          background: branchMenuOpen === branch.name ? THEME_ACCENT_SOFT : THEME_BG_CARD,
                          color: branchMenuOpen === branch.name ? THEME_ACCENT : 'var(--t-text-secondary)',
                          cursor: 'pointer',
                          flexShrink: 0,
                          transition: 'all 120ms ease',
                          boxShadow: '0 3px 8px rgba(15, 23, 42, 0.08)',
                        }}
                        onMouseEnter={(e) => {
                          const target = e.currentTarget as HTMLButtonElement;
                          if (branchMenuOpen !== branch.name) {
                            target.style.background = THEME_ACCENT_SOFT;
                            target.style.borderColor = THEME_ACCENT_BORDER;
                            target.style.color = THEME_ACCENT;
                          }
                        }}
                        onMouseLeave={(e) => {
                          const target = e.currentTarget as HTMLButtonElement;
                          if (branchMenuOpen !== branch.name) {
                            target.style.background = THEME_BG_CARD;
                            target.style.borderColor = 'var(--t-panel-border)';
                            target.style.color = 'var(--t-text-secondary)';
                          }
                        }}
                        aria-label={`Open branch actions for ${branch.name}`}
                      >
                        <OverflowDotsIcon color="currentColor" />
                      </button>
                    ) : null}
                  </div>
                  {/* Branch overflow menu */}
                  {branchMenuOpen === branch.name ? (
                    <div style={{
                      marginLeft: 30 + 6,
                      marginBottom: 4,
                      padding: '3px 0',
                      borderRadius: 8,
                      border: '1px solid var(--t-panel-border)',
                      background: THEME_PANEL_GLASS,
                      backdropFilter: 'blur(16px)',
                      width: 'fit-content',
                      minWidth: 120,
                    }}>
                      {[
                        { label: 'Open PR', action: () => { setBranchMenuOpen(null); window.open(`${githubUrlFromRemote(repo.remoteUrl)}/compare/${branch.name}?expand=1`, '_blank'); } },
                        { label: 'Delete', action: () => handleDeleteBranch(branch.name), danger: true },
                      ].map((item) => (
                        <button
                          key={item.label}
                          type="button"
                          onClick={(e) => { e.stopPropagation(); item.action(); }}
                          disabled={branchDeleting === branch.name}
                          style={{
                            display: 'block',
                            width: '100%',
                            padding: '5px 10px',
                            border: 'none',
                            background: 'transparent',
                            color: item.danger ? '#dc2626' : 'var(--t-text)',
                            fontSize: 11,
                            fontWeight: 500,
                            cursor: 'pointer',
                            textAlign: 'left',
                            fontFamily: '-apple-system, system-ui, sans-serif',
                            opacity: branchDeleting === branch.name ? 0.5 : 1,
                          }}
                        >
                          {branchDeleting === branch.name && item.danger ? 'Deleting…' : item.label}
                        </button>
                      ))}
                    </div>
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
              gap: 6,
              padding: '6px 6px',
              marginTop: 2,
              borderRadius: 8,
              background: 'rgba(37,99,235,0.03)',
              border: '1px solid rgba(37,99,235,0.08)',
            }}>
              <input
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.currentTarget.value)}
                placeholder="feat/my-feature"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateBranch(); if (e.key === 'Escape') { setCreateBranchOpen(false); setNewBranchName(''); } }}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--t-btn-secondary-border)',
                  background: 'rgba(255,255,255,0.7)',
                  fontSize: 12,
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  outline: 'none',
                  color: 'var(--t-text)',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 10, color: 'var(--t-text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={newBranchWorktree}
                    onChange={(e) => setNewBranchWorktree(e.currentTarget.checked)}
                    style={{ accentColor: '#ef4444' }}
                  />
                  Create worktree
                </label>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => { setCreateBranchOpen(false); setNewBranchName(''); setNewBranchError(null); }}
                  style={{ fontSize: 10, color: 'var(--t-text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
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
                    color: '#fff',
                    background: '#2563eb',
                    border: 'none',
                    borderRadius: 5,
                    padding: '3px 8px',
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
                gap: 4,
                padding: '4px 6px',
                marginTop: 2,
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-muted)',
                fontSize: 11,
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
                borderRadius: 6,
                transition: 'color 120ms',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = THEME_ACCENT; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--t-text-muted)'; }}
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
          {(() => {
            const staleBranches = branches.filter(b => b.isStale);
            if (staleBranches.length === 0) return null;
            const totalDisk = staleBranches.filter(b => b.diskSize).map(b => b.diskSize!).join(' + ');
            return (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 8px',
                marginTop: 4,
                borderRadius: 8,
                background: 'rgba(217, 119, 6, 0.04)',
                border: '1px solid rgba(217, 119, 6, 0.1)',
              }}>
                <AlertCircle size={11} strokeWidth={2} style={{ color: '#d97706', flexShrink: 0 }} />
                <span style={{ fontSize: 10, color: '#92400e', flex: 1 }}>
                  {staleBranches.length} stale branch{staleBranches.length > 1 ? 'es' : ''}
                  {totalDisk ? ` · ${totalDisk}` : ''}
                </span>
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation();
                    for (const sb of staleBranches) {
                      await handleDeleteBranch(sb.name, true);
                    }
                  }}
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: '#d97706',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    borderRadius: 4,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}
                >
                  Clean up
                </button>
              </div>
            );
          })()}

          {/* Repo metadata — compact */}
          <div
            style={{
              fontSize: 10,
              color: 'var(--t-text-faint)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              lineHeight: 1.6,
              marginTop: 4,
            }}
          >
            <div>{shortenPath(repo.localPath)}</div>
            {repo.remoteUrl ? (
              <div>{repo.remoteUrl.replace(/^https?:\/\//, '')}</div>
            ) : null}
          </div>
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
  onLaunchComplete,
  onLaunchWorkspaceAgent,
  activeRepoLocalPath = null,
  sectionOpen,
  onSectionOpenChange,
  launchIntent,
  hideHeader = false,
}: {
  onSelectSession?: (sessionKey: string) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onLaunchComplete?: () => void;
  onLaunchWorkspaceAgent?: (request: WorkspaceAgentLaunchRequest) => Promise<void>;
  activeRepoLocalPath?: string | null;
  sectionOpen?: boolean;
  onSectionOpenChange?: (open: boolean) => void;
  launchIntent?: { repoPath: string | null; nonce: number } | null;
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
  const [openClawBetaEnabled, setOpenClawBetaEnabled] = useState(() => readOpenClawBetaEnabled());

  useEffect(() => {
    try {
      if (expandedRepoId) sessionStorage.setItem('cortex-repo-expanded-id', expandedRepoId);
      else sessionStorage.removeItem('cortex-repo-expanded-id');
    } catch { /* ignore */ }
  }, [expandedRepoId]);

  useEffect(() => subscribeOpenClawBetaEnabled(setOpenClawBetaEnabled), []);

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

  // ── Agent ↔ Branch association (#168) ──
  const [agentBranchMap, setAgentBranchMap] = useState<Map<string, Map<string, BranchAgent[]>>>(new Map());

  useEffect(() => {
    function fetchAgentBranches() {
      fetch(appendOpenClawBetaQuery('/api/panel/workspaces', openClawBetaEnabled))
        .then(r => r.json())
        .then((data: { workspaces?: { repo: string; branch: string; agentName: string; sessionKey: string; agentStatus: string }[] }) => {
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
            // Deduplicate by session key
            const existing = branchMap.get(ws.branch)!;
            if (!existing.some(a => a.sessionKey === ws.sessionKey)) {
              existing.push({ name: displayName, sessionKey: ws.sessionKey, color });
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

  const handleValidate = useCallback(async () => {
    const localPath = repoPathInput.trim();
    if (!localPath) {
      setValidationError('Enter a local folder path.');
      setValidationResult(null);
      return;
    }

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
  }, [repoPathInput]);

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
      setRemoveTarget(null);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'Unable to remove repository.');
    } finally {
      setRemoveBusy(false);
    }
  }, [removeTarget]);

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

  const branchPreview = useMemo(() => getWorkspaceBranchPreview(workspaceName), [workspaceName]);

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
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 10,
                color: 'var(--t-text-faint)',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {reposOpen ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
            </span>
          </button>
        </div>
      ) : null}

      {reposOpen ? (
        <div
          style={{
            flexShrink: 0,
            paddingTop: 0,
            paddingRight: hideHeader ? 0 : 14,
            paddingBottom: 8,
            paddingLeft: hideHeader ? 0 : 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {/* Compact repo list — no top button, Add is at bottom */}

          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  style={{
                    borderRadius: 14,
                    border: '1px solid var(--t-panel-border)',
                    background: THEME_PANEL_GLASS,
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    boxShadow: 'var(--t-panel-shadow)',
                    padding: '12px 12px 10px',
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
                padding: 12,
                borderRadius: 14,
                border: '1px solid rgba(239, 68, 68, 0.16)',
                background: 'rgba(254, 242, 242, 0.9)',
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

          {!loading && !loadError && repos.length === 0 ? (
            <div
              style={{
                padding: 14,
                borderRadius: 14,
                border: '1px solid var(--t-panel-border)',
                background: THEME_PANEL_GLASS,
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                boxShadow: 'var(--t-panel-shadow)',
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: 'var(--t-text)',
                  letterSpacing: '-0.01em',
                }}
              >
                Bring a repo into Cortex
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: 'var(--t-text-muted)',
                }}
              >
                Add a local Git repository, persist it in the repo registry, and spin up isolated workspaces from the same panel.
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
                onOpenLaunchOptions={openLaunchModal}
                onOpenGitHub={handleOpenGitHub}
                onRemove={setRemoveTarget}
                onSaveSetup={handleSaveSetup}
                onSelectPR={onSelectPR}
                onSelectBranch={(branch, repoPath) => {
                  // Future: switch conversation context to agent on this branch
                  // For now: could trigger file tree refresh for this branch
                }}
                agentsByBranch={agentBranchMap.get(repo.name)}
                activePorts={portsByRepo.get(repo.name)}
                expanded={expandedRepoId === repo.id}
                onToggle={() => setExpandedRepoId((current) => current === repo.id ? null : repo.id)}
                isActive={repo.localPath === activeRepoLocalPath}
              />
            ))
          ) : null}

          {/* Compact footer — Add repository */}
          {!loading ? (
            <button
              type="button"
              onClick={() => {
                setAddOpen(true);
                setValidationError(null);
                setValidationResult(null);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 4px',
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-secondary)',
                fontSize: 11,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              <FolderOpen size={12} strokeWidth={2} />
              Add repository
            </button>
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
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Local folder path
          </div>
          <input
            value={repoPathInput}
            onChange={(event) => {
              setRepoPathInput(event.currentTarget.value);
              setValidationError(null);
              setValidationResult(null);
            }}
            placeholder="~/projects/cortex-ide"
            autoFocus
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
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Workspace name
          </div>
          <input
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
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Base branch
          </div>
          <input
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
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Runtime
          </div>
          <select
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
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Tab label
          </div>
          <input
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
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Initial prompt
          </div>
          <textarea
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
