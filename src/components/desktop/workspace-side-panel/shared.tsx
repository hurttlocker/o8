'use client';

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, FileEdit, FileMinus, FilePlus, FileText, MessageSquare } from '../lucide-shims';
import type { ReviewChangedFile, ReviewWorktreeSummary } from '@/lib/fleet/types';
import type { RepoReadiness } from '@/lib/repos/types';
import type { WorkspacePanelTabId, WorkspaceReviewCheckRun, WorkflowRunGroup, WorkspaceChatTargetOption } from './types';

export const THEME_ACCENT = 'var(--t-accent, #2563eb)';
export const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
export const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
export const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';
export const THEME_ROW_HOVER = 'var(--t-hover)';

// ── Color Maps ───────────────────────────────────────────────────────
const FILE_NAME_COLORS: Record<string, string> = {
  'package.json': '#f59e0b', 'tsconfig.json': '#3178c6', 'next.config.js': '#111827',
  'next.config.ts': '#111827', 'README.md': '#519aba', 'CHANGELOG.md': '#519aba',
  '.env': '#ecd53f', '.env.local': '#ecd53f', '.gitignore': '#f05032',
  'CLAUDE.md': '#d97706', 'AGENTS.md': '#d97706',
};

const FILE_ICON_COLORS: Record<string, string> = {
  '.ts': '#3178c6', '.tsx': '#3178c6', '.js': '#f1e05a', '.jsx': '#61dafb',
  '.json': '#f59e0b', '.md': '#519aba', '.css': '#ec4899', '.scss': '#ec4899',
  '.html': '#e34c26', '.yml': '#cb171e', '.yaml': '#cb171e', '.svg': '#f59e0b',
};

const FOLDER_COLORS: Record<string, string> = {
  src: '#42a5f5', app: '#ef5350', components: '#ab47bc', lib: '#26a69a',
  hooks: '#7e57c2', public: '#66bb6a', assets: '#ffa726', api: '#42a5f5',
  config: '#78909c', docs: '#42a5f5', scripts: '#78909c', '.github': '#6e5494',
};

// ── Utility Functions ────────────────────────────────────────────────
export function shortenPath(value: string) {
  const userPath = value.replace(/^\/Users\/[^/]+/, '~');
  if (userPath !== value) return userPath;
  return value.replace(/^\/home\/[^/]+/, '~');
}

export function getFileIconColor(name: string) {
  const lower = name.toLowerCase();
  if (FILE_NAME_COLORS[lower]) return FILE_NAME_COLORS[lower];
  if (FILE_NAME_COLORS[name]) return FILE_NAME_COLORS[name];
  const ext = `.${name.split('.').pop()?.toLowerCase() ?? ''}`;
  return FILE_ICON_COLORS[ext] ?? 'var(--t-text-faint)';
}

export function getFolderColor(name: string) {
  return FOLDER_COLORS[name.toLowerCase()] ?? '#42a5f5';
}

export function repoSlugFromRemote(remoteUrl?: string) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

export function normalizeBranchName(value?: string | null) {
  return value?.trim().replace(/^refs\/heads\//, '') || null;
}

export function branchesMatch(left?: string | null, right?: string | null) {
  const normalizedLeft = normalizeBranchName(left);
  const normalizedRight = normalizeBranchName(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function formatAge(value?: string | number | null) {
  if (!value) return 'now';
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const diffMs = Date.now() - ms;
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.max(1, Math.round(diffMs / 60_000))}m ago`;
  if (diffMs < 86_400_000) return `${Math.max(1, Math.round(diffMs / 3_600_000))}h ago`;
  return `${Math.max(1, Math.round(diffMs / 86_400_000))}d ago`;
}

export async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 10000): Promise<T> {
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

export function shortSha(value?: string | null) {
  return value ? value.slice(0, 7) : null;
}

export function workflowRunTone(run: { status?: string | null; conclusion?: string | null }) {
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

export function groupWorkflowRuns(runs: WorkspaceReviewCheckRun[], fallbackBranch?: string | null): WorkflowRunGroup[] {
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

export function worktreeStateLabel(worktree: ReviewWorktreeSummary) {
  if (worktree.isCurrent) return 'Current';
  if (worktree.prunableReason) return 'Prunable';
  if (worktree.lockedReason) return 'Locked';
  if (worktree.isDetached) return 'Detached';
  return 'Ready';
}

export function worktreeStateTone(worktree: ReviewWorktreeSummary) {
  if (worktree.isCurrent) return { bg: 'rgba(37, 99, 235, 0.08)', color: THEME_ACCENT };
  if (worktree.prunableReason) return { bg: 'rgba(239, 68, 68, 0.08)', color: '#b91c1c' };
  if (worktree.lockedReason) return { bg: 'rgba(245, 158, 11, 0.1)', color: '#b45309' };
  return { bg: 'var(--t-divider-subtle)', color: 'var(--t-text-secondary)' };
}

export function prStateLabel(pr: { reviewDecision?: string | null; isDraft?: boolean; state?: string | null }) {
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { label: 'Changes requested', color: '#b91c1c', bg: 'rgba(239, 68, 68, 0.08)' };
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return { label: 'Review pending', color: THEME_ACCENT, bg: THEME_ACCENT_SOFT };
  if (pr.isDraft) return { label: 'Draft', color: '#b45309', bg: 'rgba(245, 158, 11, 0.1)' };
  return { label: !pr.state || pr.state === 'OPEN' ? 'Open' : pr.state, color: 'var(--t-text-secondary)', bg: 'var(--t-divider-subtle)' };
}

// ── Small Shared UI Components ───────────────────────────────────────
export function WorkspaceDiffStatusIcon({ status }: { status: ReviewChangedFile['status'] | string }) {
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

export function PanelTab({
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

const FILES_TAB_OPTIONS: { id: WorkspacePanelTabId; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'files', label: 'All Files' },
  { id: 'env', label: 'Env' },
];

export function FilesTabDropdown({
  activeTab,
  onSelectTab,
}: {
  activeTab: WorkspacePanelTabId;
  onSelectTab: (tab: WorkspacePanelTabId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isFilesGroup = activeTab === 'changes' || activeTab === 'files' || activeTab === 'env';
  const activeOption = FILES_TAB_OPTIONS.find((o) => o.id === activeTab) ?? FILES_TAB_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => {
          if (!isFilesGroup) {
            onSelectTab('changes');
          } else {
            setOpen((v) => !v);
          }
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          padding: '6px 8px',
          borderRadius: 999,
          border: 'none',
          background: isFilesGroup ? 'var(--t-hover)' : 'transparent',
          color: isFilesGroup ? 'var(--t-text)' : 'var(--t-text-secondary)',
          fontSize: 10,
          fontWeight: 700,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {isFilesGroup ? activeOption.label : 'Changes'}
        <svg width={8} height={8} viewBox="0 0 256 256" fill="currentColor" style={{ display: 'block', opacity: 0.5 }}><path d="M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159,199.51,87.51a12,12,0,0,1,17,17Z" /></svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          minWidth: 120,
          padding: '4px',
          borderRadius: 10,
          border: '1px solid var(--t-panel-border)',
          background: 'var(--t-panel-solid)',
          backdropFilter: 'none',
          WebkitBackdropFilter: 'none',
          boxShadow: 'var(--t-panel-shadow), 0 8px 32px rgba(15, 23, 42, 0.18)',
          zIndex: 100,
          color: 'var(--t-text)',
        } as React.CSSProperties}>
          {FILES_TAB_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => { onSelectTab(option.id); setOpen(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '6px 10px',
                borderRadius: 6,
                border: 'none',
                background: activeTab === option.id ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                color: activeTab === option.id ? '#e2e8f0' : '#94a3b8',
                fontSize: 11,
                fontWeight: activeTab === option.id ? 600 : 500,
                cursor: 'pointer',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ContextActionChip({
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

export function ContextHintBadge({
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

export function ChatTargetSelector({
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
            border: '1px solid var(--t-panel-border)',
            background: 'var(--t-panel-solid)',
            boxShadow: 'var(--t-panel-shadow), 0 8px 32px rgba(15, 23, 42, 0.18)',
            backdropFilter: 'none',
            WebkitBackdropFilter: 'none',
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
                  background: selected ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                  color: '#e2e8f0',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <MessageSquare size={12} strokeWidth={2} style={{ color: selected ? THEME_ACCENT : 'var(--t-text-faint)', marginTop: 1, flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#e2e8f0' }}>{option.label}</div>
                  {option.detail ? (
                    <div style={{ marginTop: 2, fontSize: 10, color: '#94a3b8' }}>
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

export function ContextIconButton({
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

export function PrimaryActionButton({
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

export function ReviewSection({
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

export function ContextObjectCard({
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

export function EmptySectionState({ children }: { children: React.ReactNode }) {
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
