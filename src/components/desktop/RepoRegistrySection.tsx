'use client';

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Plus,
  PlayCircle,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  RepoRegistryEntry,
  RepoSetupConfig,
  RepoSetupEnvMode,
  ValidatedRepoCandidate,
} from '@/lib/repos/types';

interface JsonErrorShape {
  error?: string;
}

interface WorkspaceCreateResult {
  id: string;
  branch: string;
  path: string;
  baseBranch: string;
}

interface LaunchAgentResult {
  surfaceId: string;
  runtime: string;
  note: string;
  cwd: string;
  worktree: WorkspaceCreateResult | null;
}

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
  };
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

function RepoCard({
  repo,
  workspaceNotice,
  onLaunchAgent,
  onOpenGitHub,
  onRemove,
  onSaveSetup,
  onSelectBranch,
  agentsByBranch,
}: {
  repo: RepoRegistryEntry;
  workspaceNotice: WorkspaceCreateResult | null;
  onLaunchAgent: (repo: RepoRegistryEntry) => void;
  onOpenGitHub: (repo: RepoRegistryEntry) => void;
  onRemove: (repo: RepoRegistryEntry) => void;
  onSaveSetup: (repoId: string, setup: RepoSetupConfig) => Promise<void>;
  onSelectBranch?: (branch: string, repoPath: string) => void;
  agentsByBranch?: Map<string, BranchAgent[]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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

  useEffect(() => {
    setDraftSetup(repo.setup);
  }, [repo.setup]);

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
  const hasUnsavedChanges = JSON.stringify(draftSetup) !== JSON.stringify(repo.setup);

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

  return (
    <div style={{ borderBottom: '1px solid var(--t-divider-subtle)' }}>
      {/* Compact header row — Conductor style */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 4px',
          cursor: 'pointer',
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ color: 'var(--t-text-muted)', flexShrink: 0, display: 'flex' }}>
          {expanded ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
        </span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
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
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            padding: '1px 6px',
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
        {/* Overflow menu trigger */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 6,
            border: 'none',
            background: menuOpen ? 'var(--t-divider-subtle)' : 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <MoreHorizontal size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Overflow menu dropdown */}
      {menuOpen ? (
        <div
          style={{
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              right: 4,
              top: -4,
              zIndex: 50,
              minWidth: 160,
              padding: '4px 0',
              borderRadius: 10,
              border: '1px solid var(--t-panel-border)',
              background: 'rgba(255, 255, 255, 0.95)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
            }}
          >
            {[
              { label: 'Launch Agent', icon: <PlayCircle size={12} strokeWidth={2} />, action: () => { onLaunchAgent(repo); setMenuOpen(false); } },
              { label: 'Settings', icon: <Settings2 size={12} strokeWidth={2} />, action: () => { setSettingsOpen((v) => !v); setMenuOpen(false); } },
              ...(githubUrl ? [{ label: 'Open on GitHub', icon: <ExternalLink size={12} strokeWidth={2} />, action: () => { onOpenGitHub(repo); setMenuOpen(false); } }] : []),
              { label: 'Remove', icon: <Trash2 size={12} strokeWidth={2} />, action: () => { onRemove(repo); setMenuOpen(false); }, danger: true },
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
                  padding: '7px 12px',
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
        </div>
      ) : null}

      {/* Expanded content */}
      {expanded ? (
        <div style={{ padding: '0 4px 8px 28px' }}>
          {/* Primary action */}
          <div style={{ marginBottom: 6 }}>
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
                color: '#2563eb',
                fontSize: 11,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              <PlayCircle size={11} strokeWidth={2} />
              Launch agent
            </button>
          </div>

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
              <span style={{ fontSize: 10, color: '#15803d', fontWeight: 600 }}>Ready</span>
            </div>
          ) : null}

          {/* Branch list — Apple-grade progressive disclosure */}
          <div style={{ marginTop: 6 }}>
            {branchesLoading ? (
              <div style={{ fontSize: 11, color: 'var(--t-text-faint)', padding: '4px 0' }}>Loading branches…</div>
            ) : branches.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {branches.map((branch) => (
                  <div key={branch.name}>
                  <div
                    onClick={() => onSelectBranch?.(branch.name, repo.localPath)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '5px 6px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      transition: 'background 120ms ease',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(37,99,235,0.04)'; }}
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
                    {agentsByBranch?.get(branch.name)?.map((agent) => (
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
                    {branch.diskSize ? (
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
                    {branch.ahead > 0 || branch.behind > 0 ? (
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
                          width: 20,
                          height: 20,
                          borderRadius: 4,
                          border: 'none',
                          background: branchMenuOpen === branch.name ? 'rgba(0,0,0,0.04)' : 'transparent',
                          color: 'var(--t-text-muted)',
                          cursor: 'pointer',
                          flexShrink: 0,
                          opacity: 0.5,
                          transition: 'opacity 120ms',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.5'; }}
                      >
                        <MoreHorizontal size={12} strokeWidth={2} />
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
                      background: 'rgba(255,255,255,0.95)',
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
                ))}
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
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#2563eb'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--t-text-muted)'; }}
            >
              <Plus size={11} strokeWidth={2} />
              New branch
            </button>
          )}

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
  onLaunchComplete,
}: {
  onSelectSession?: (sessionKey: string) => void;
  onLaunchComplete?: () => void;
} = {}) {
  const [repos, setRepos] = useState<RepoRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reposOpen, setReposOpen] = useState(true);

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
  const [launchRuntime, setLaunchRuntime] = useState<'codex' | 'claude-code' | 'openclaw'>('codex');
  const [launchTaskName, setLaunchTaskName] = useState('');
  const [launchPrompt, setLaunchPrompt] = useState('');
  const [launchBaseBranch, setLaunchBaseBranch] = useState('');
  const [launchUseSetup, setLaunchUseSetup] = useState(true);
  const [launchLoading, setLaunchLoading] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchResult, setLaunchResult] = useState<LaunchAgentResult | null>(null);
  const [launchIsolation, setLaunchIsolation] = useState<'main' | 'branch'>('main');

  const [removeTarget, setRemoveTarget] = useState<RepoRegistryEntry | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

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

  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  // ── Agent ↔ Branch association (#168) ──
  const [agentBranchMap, setAgentBranchMap] = useState<Map<string, Map<string, BranchAgent[]>>>(new Map());

  useEffect(() => {
    function fetchAgentBranches() {
      fetch('/api/panel/workspaces')
        .then(r => r.json())
        .then((data: { workspaces?: { repo: string; branch: string; agentName: string; sessionKey: string; agentStatus: string }[] }) => {
          const map = new Map<string, Map<string, BranchAgent[]>>();
          const AGENT_COLORS: Record<string, string> = {
            'Mister': '#111827',
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
    setLaunchRuntime('codex');
    setLaunchTaskName(defaultWorkspaceName(repo.name));
    setLaunchPrompt(`Work on ${repo.name}. Start by reading CLAUDE.md and the relevant issue context, then implement the requested change.`);
    setLaunchBaseBranch(repo.defaultBranch);
    setLaunchUseSetup(repo.setup.installOnCreateWorkspace);
    setLaunchIsolation('main');
    setLaunchError(null);
    setLaunchResult(null);
  }, []);

  const closeLaunchModal = useCallback(() => {
    setLaunchRepo(null);
    setLaunchRuntime('codex');
    setLaunchTaskName('');
    setLaunchPrompt('');
    setLaunchBaseBranch('');
    setLaunchUseSetup(true);
    setLaunchLoading(false);
    setLaunchError(null);
    setLaunchResult(null);
  }, []);

  const handleLaunchAgent = useCallback(async () => {
    if (!launchRepo) return;

    const taskName = launchTaskName.trim();
    const prompt = launchPrompt.trim();
    if (!taskName) {
      setLaunchError('Task name is required.');
      return;
    }
    if (!prompt) {
      setLaunchError('Launch prompt is required.');
      return;
    }

    setLaunchLoading(true);
    setLaunchError(null);

    try {
      const data = await requestJson<LaunchAgentResult>('/api/runtime/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runtime: launchRuntime,
          repoPath: launchRepo.localPath,
          prompt,
          taskName,
          baseBranch: launchIsolation === 'branch' ? (launchBaseBranch.trim() || undefined) : undefined,
          skipSetup: launchIsolation === 'main' ? true : !launchUseSetup,
          isolation: launchIsolation,
        }),
      });

      setLaunchResult(data);

      const touched = await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'touch', id: launchRepo.id }),
      });

      setRepos((current) => sortRepoEntries(
        current.map((repo) => (repo.id === launchRepo.id ? touched.repo : repo)),
      ));

      onLaunchComplete?.();
      if (data.surfaceId) {
        onSelectSession?.(data.surfaceId);
      }
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : 'Unable to launch agent.');
    } finally {
      setLaunchLoading(false);
    }
  }, [
    launchBaseBranch,
    launchIsolation,
    launchPrompt,
    launchRepo,
    launchRuntime,
    launchTaskName,
    launchUseSetup,
    onLaunchComplete,
    onSelectSession,
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

  const branchPreview = useMemo(() => getWorkspaceBranchPreview(workspaceName), [workspaceName]);

  return (
    <>
      <div style={{ flexShrink: 0, paddingLeft: 14, paddingRight: 14, paddingTop: 0, paddingBottom: 0 }}>
        <button
          type="button"
          onClick={() => setReposOpen((current) => !current)}
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
            {repos.length}
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

      {reposOpen ? (
        <div
          style={{
            flexShrink: 0,
            paddingTop: 0,
            paddingRight: 14,
            paddingBottom: 8,
            paddingLeft: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {/* Compact repo list — no top button, Add is at bottom */}

          {loading ? (
            <div style={{ fontSize: 13, color: 'var(--t-text-muted)', padding: '8px 2px' }}>Loading repositories…</div>
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
                background: 'rgba(255, 255, 255, 0.7)',
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
            repos.map((repo) => (
              <RepoCard
                key={repo.id}
                repo={repo}
                workspaceNotice={workspaceNotice[repo.id] ?? null}
                onLaunchAgent={openLaunchModal}
                onOpenGitHub={handleOpenGitHub}
                onRemove={setRemoveTarget}
                onSaveSetup={handleSaveSetup}
                onSelectBranch={(branch, repoPath) => {
                  // Future: switch conversation context to agent on this branch
                  // For now: could trigger file tree refresh for this branch
                }}
                agentsByBranch={agentBranchMap.get(repo.name)}
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
                color: 'var(--t-text-muted)',
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
            placeholder="~/clawd/repos/cortex-ide"
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
            Saved repo setup includes env/build preferences. Those fields are stored now and can be wired into workspace bootstrap separately.
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
        subtitle="Choose a runtime and task. The agent will start working immediately."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Runtime
          </div>
          <select
            value={launchRuntime}
            onChange={(event) => setLaunchRuntime(event.currentTarget.value as 'codex' | 'claude-code' | 'openclaw')}
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
            <option value="openclaw">OpenClaw</option>
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
            Task name
          </div>
          <input
            value={launchTaskName}
            onChange={(event) => setLaunchTaskName(event.currentTarget.value)}
            placeholder="cortex-issue-131"
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
            Launch prompt
          </div>
          <textarea
            value={launchPrompt}
            onChange={(event) => setLaunchPrompt(event.currentTarget.value)}
            rows={6}
            placeholder="Describe the task for the agent."
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

        {launchRuntime === 'openclaw' ? (
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
            OpenClaw launch dispatches the task into the live mirrored session instead of creating a repo worktree. Base branch and setup controls do not apply on that lane.
          </div>
        ) : (
          <>
            {/* ── Isolation Mode — iOS Segmented Control ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
                Isolation
              </div>
              <div style={{
                display: 'flex',
                padding: 2,
                borderRadius: 10,
                background: 'rgba(0, 0, 0, 0.04)',
                gap: 0,
              }}>
                {(['main', 'branch'] as const).map((mode) => {
                  const active = launchIsolation === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setLaunchIsolation(mode)}
                      style={{
                        flex: 1,
                        padding: '7px 0',
                        borderRadius: 8,
                        border: 'none',
                        background: active ? '#fff' : 'transparent',
                        boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)' : 'none',
                        color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
                        fontSize: 12,
                        fontWeight: active ? 600 : 500,
                        cursor: 'pointer',
                        transition: 'all 180ms cubic-bezier(0.32, 0.72, 0, 1)',
                        fontFamily: '-apple-system, system-ui, sans-serif',
                        letterSpacing: '-0.01em',
                      }}
                    >
                      {mode === 'main' ? 'On current branch' : 'New branch'}
                    </button>
                  );
                })}
              </div>
              <div style={{
                fontSize: 10,
                color: 'var(--t-text-faint)',
                lineHeight: 1.4,
                marginTop: 2,
              }}>
                {launchIsolation === 'main'
                  ? 'Agent works directly on the current branch. Fast, no setup overhead.'
                  : 'Agent gets an isolated worktree with its own branch. No conflicts with other work.'}
              </div>
            </div>

            {/* ── Branch config (only shown for worktree isolation) ── */}
            {launchIsolation === 'branch' ? (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
                    Base branch
                  </div>
                  <input
                    value={launchBaseBranch}
                    onChange={(event) => setLaunchBaseBranch(event.currentTarget.value)}
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
                    checked={launchUseSetup}
                    onChange={(event) => setLaunchUseSetup(event.currentTarget.checked)}
                    style={{
                      marginTop: 2,
                      accentColor: '#ef4444',
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
                      Run dependency setup in new worktree
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
                      {launchRepo?.setup.installCommand ?? 'No install command detected'}
                    </div>
                  </div>
                </label>
              </>
            ) : null}
          </>
        )}

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

        {launchResult ? (
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
              Agent launched
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: '6px 10px', fontSize: 12 }}>
              <span style={{ color: 'var(--t-text-muted)' }}>Runtime</span>
              <span style={{ color: 'var(--t-text)', fontWeight: 600 }}>{launchResult.runtime}</span>
              <span style={{ color: 'var(--t-text-muted)' }}>Surface</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {launchResult.surfaceId}
              </span>
              <span style={{ color: 'var(--t-text-muted)' }}>CWD</span>
              <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                {shortenPath(launchResult.cwd)}
              </span>
              {launchResult.worktree ? (
                <>
                  <span style={{ color: 'var(--t-text-muted)' }}>Worktree</span>
                  <span style={{ color: 'var(--t-text)', fontFamily: '"SF Mono", ui-monospace, monospace', wordBreak: 'break-all' }}>
                    {launchResult.worktree.branch}
                  </span>
                </>
              ) : null}
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.5, color: '#166534' }}>
              {launchResult.note}
            </div>
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
            {launchResult ? 'Close' : 'Cancel'}
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
            {launchLoading ? 'Launching…' : launchResult ? 'Launch Another' : 'Launch Agent'}
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
