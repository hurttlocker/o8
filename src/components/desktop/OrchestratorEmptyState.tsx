'use client';

/**
 * OrchestratorEmptyState — the compose-first landing for any chat-shaped
 * workspace tab that hasn't received its first message yet.
 *
 * Shows a dynamic question title above the ready composer. First-message
 * context is selected in the composer row below the input.
 */

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Computer as IconoirComputer,
  FolderPlus as IconoirFolderPlus,
  GitBranch as IconoirGitBranch,
} from 'iconoir-react';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { OrchestratorProjectPicker } from './orchestrator/OrchestratorProjectPicker';

export type WorktreeMode = 'local' | 'new-worktree';
export type OrchestratorEmptyKind = 'orchestrator' | 'chat';

interface OrchestratorEmptyStateProps {
  repoPath: string | null;
  repoLabel: string | null;
  workspaceTargets: OrchestratorWorkspaceTarget[];
  onSelectProject?: (target: OrchestratorWorkspaceTarget) => void;
  onAddProject?: (mode?: 'scratch' | 'existing') => void;
  onWorkWithoutProject?: () => void;
  kind: OrchestratorEmptyKind;
}

function OrchestratorEmptyStateBase(props: OrchestratorEmptyStateProps) {
  const { repoLabel, repoPath, workspaceTargets, onAddProject, kind } = props;

  // No active workspace → the orchestrator has nothing to act on, and sends are
  // silently dropped (useOrchestratorStream bails when repoPath is null). A new
  // user otherwise types into the void and the message vanishes. Lead with an
  // explicit "add a repo" CTA instead of a compose prompt so that can't happen.
  // (Only for the orchestrator — the plain chat kind works without a repo.)
  if (kind !== 'chat' && !repoPath) {
    const noReposAtAll = (workspaceTargets?.length ?? 0) === 0;
    return (
      <NoWorkspaceCallout
        noReposAtAll={noReposAtAll}
        workspaceTargets={workspaceTargets}
        onSelectProject={props.onSelectProject}
        onAddProject={onAddProject}
        onWorkWithoutProject={props.onWorkWithoutProject}
      />
    );
  }

  const homeMode = repoPath === '~';
  const titleProject = repoLabel ?? 'your workspace';
  const title = homeMode ? 'What should we do?' : `What should we build in ${titleProject}?`;

  return (
    <div
      style={{
        display: 'flex',
        flex: 'none',
        minHeight: 0,
        minWidth: 0,
        width: '100%',
        boxSizing: 'border-box',
        // The transcript and composer now form one centered empty-state stack.
        // Natural height keeps the prompt just above the ready composer.
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 12,
        paddingLeft: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          maxWidth: 640,
          minWidth: 0,
        }}
      >
        <h1
          style={{
            // Lighter weight per operator pass — 200 reads as airy
            // editorial instead of the 300 sidebar weight. Font scales with
            // the workspace (cqw — the ThoughtsChatPanel root is a size
            // container) so it shrinks gracefully as the panel narrows, and
            // `text-wrap: balance` keeps the line breaks even — no
            // single-word orphans ("What / should we / build in / o8?").
            fontSize: 'clamp(19px, 5cqw, 30px)',
            fontWeight: 200,
            color: 'var(--t-text)',
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
            fontFamily: 'var(--font-sans-system)',
            textAlign: 'center',
            textWrap: 'balance',
            margin: 0,
          }}
        >
          {title}
        </h1>
      </div>
    </div>
  );
}

/**
 * NoWorkspaceCallout — shown in the orchestrator empty state when there is no
 * active repo. Replaces the "What should we build…" compose prompt with an
 * explicit "Add a repo" CTA so a brand-new user is funneled into picking a
 * workspace instead of typing a message the orchestrator silently drops.
 */
function NoWorkspaceCallout({
  noReposAtAll,
  workspaceTargets,
  onSelectProject,
  onAddProject,
  onWorkWithoutProject,
}: {
  noReposAtAll: boolean;
  workspaceTargets: OrchestratorWorkspaceTarget[];
  onSelectProject?: (target: OrchestratorWorkspaceTarget) => void;
  onAddProject?: (mode?: 'scratch' | 'existing') => void;
  onWorkWithoutProject?: () => void;
}) {
  // Repos exist but none is scoped to this thread → let the operator pick one
  // explicitly (the "Which project?" picker) instead of silently guessing —
  // guessing bled stale mission cards across projects and showed an ambiguous
  // "build in <blank>" hero. (2026-07-02)
  if (!noReposAtAll) {
    return (
      <OrchestratorProjectPicker
        workspaceTargets={workspaceTargets}
        onSelectProject={onSelectProject}
        onAddProject={onAddProject}
        onWorkWithoutProject={onWorkWithoutProject}
      />
    );
  }
  return <NoReposCallout onAddProject={onAddProject} />;
}

// No repos registered at all → lead with the add-a-repo CTA (unchanged).
function NoReposCallout({ onAddProject }: { onAddProject?: (mode?: 'scratch' | 'existing') => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 24,
        paddingLeft: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
          width: '100%',
          maxWidth: 460,
          textAlign: 'center',
        }}
      >
        <div
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 44,
            height: 44,
            borderRadius: 14,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            color: 'var(--t-text-faint)',
          }}
        >
          <IconoirFolderPlus width={20} height={20} color="currentColor" strokeWidth={1.6} />
        </div>
        <h1
          style={{
            fontSize: 'clamp(19px, 5cqw, 28px)',
            fontWeight: 200,
            color: 'var(--t-text)',
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
            fontFamily: 'var(--font-sans-system)',
            textWrap: 'balance',
            margin: 0,
          }}
        >
          Add a repo to get started
        </h1>
        <p
          style={{
            margin: 0,
            maxWidth: 380,
            fontSize: 13,
            fontWeight: 360,
            lineHeight: 1.5,
            color: 'var(--t-text-muted)',
            fontFamily: 'var(--font-sans-system)',
            textWrap: 'balance',
          }}
        >
          The orchestrator builds inside a repo. Add one and I can start working with you.
        </p>
        <button
          type="button"
          onClick={() => onAddProject?.('existing')}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 4,
            paddingTop: 9,
            paddingBottom: 9,
            paddingLeft: 16,
            paddingRight: 16,
            borderWidth: 0,
            borderRadius: 999,
            background: 'var(--t-text)',
            color: 'var(--t-chat-surface-bg)',
            opacity: hovered ? 0.88 : 1,
            cursor: 'pointer',
            fontFamily: 'var(--font-sans-system)',
            fontSize: 13,
            fontWeight: 460,
            letterSpacing: '-0.005em',
            transition: 'opacity 120ms ease',
          }}
        >
          <IconoirFolderPlus width={15} height={15} color="currentColor" strokeWidth={1.8} />
          Add a repo
        </button>
      </div>
    </div>
  );
}

export const OrchestratorEmptyState = memo(OrchestratorEmptyStateBase);

/**
 * First-message location controls live beside repository and permissions
 * beneath the composer, instead of floating above an empty workspace.
 */
interface OrchestratorStartLocationControlsProps {
  worktreeMode: WorktreeMode;
  onWorktreeModeChange: (mode: WorktreeMode) => void;
  branch: string;
  repoPath: string | null;
  onBranchChange?: (branch: string) => void;
}

const COMPACT_CONTEXT_ROW_WIDTH = 440;

function OrchestratorStartLocationControlsBase(props: OrchestratorStartLocationControlsProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const contextRow = rowRef.current?.parentElement;
    if (!contextRow || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setCompact(width < COMPACT_CONTEXT_ROW_WIDTH);
    });
    observer.observe(contextRow);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={rowRef}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <WorktreeChip mode={props.worktreeMode} onChange={props.onWorktreeModeChange} compact={compact} />
      {props.worktreeMode === 'new-worktree' ? (
        <BranchChip branch={props.branch} repoPath={props.repoPath} onChange={props.onBranchChange} compact={compact} />
      ) : null}
    </div>
  );
}

export const OrchestratorStartLocationControls = memo(OrchestratorStartLocationControlsBase);

/* ──────────────────────────────────────────────────────────────────────
 * Chip primitives
 * ────────────────────────────────────────────────────────────────────── */

export function ChipShell({
  icon,
  label,
  onClick,
  open,
  ariaLabel,
  compact,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  open?: boolean;
  ariaLabel?: string;
  compact?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const isInteractive = Boolean(onClick);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!isInteractive}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={ariaLabel ?? label}
      title={compact ? (ariaLabel ?? label) : undefined}
      aria-haspopup={isInteractive ? 'menu' : undefined}
      aria-expanded={isInteractive ? Boolean(open) : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: compact ? 4 : 7,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: compact ? 8 : 10,
        paddingRight: compact ? 8 : 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        borderRadius: 999,
        background: open || hovered ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text-secondary)',
        cursor: isInteractive ? 'pointer' : 'default',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 12,
        fontWeight: 360,
        letterSpacing: '-0.005em',
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0, color: 'var(--t-text-faint)' }}>
        {icon}
      </span>
      {compact ? null : <span style={{ whiteSpace: 'nowrap' }}>{label}</span>}
      {isInteractive ? <Caret /> : null}
    </button>
  );
}

function Caret() {
  return (
    <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * Popover anchored to the chip below, click-outside dismiss.
 *
 * Rendered through a portal to document.body — the empty-state column
 * inside ThoughtsChatPanel has overflow:hidden, which used to clip the
 * popover to just the first row. With a portal + fixed positioning,
 * the menu always appears at full height regardless of which surface
 * is hosting the chip.
 */
function ChipPopover({
  open,
  onClose,
  anchorRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  // Recompute the menu's screen position whenever it opens (or the
  // viewport changes underneath it). Place 6 px below the anchor; if
  // there's not enough room, flip above. The menu's own width is
  // measured after first paint and used for right-edge clamping.
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const compute = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuHeightEstimate = menuRef.current?.offsetHeight ?? 240;
      const menuWidthEstimate = menuRef.current?.offsetWidth ?? 232;
      const spaceBelow = window.innerHeight - rect.bottom;
      const flipUp = spaceBelow < menuHeightEstimate + 12 && rect.top > menuHeightEstimate + 12;
      const top = flipUp ? rect.top - menuHeightEstimate - 6 : rect.bottom + 6;
      const leftMax = window.innerWidth - menuWidthEstimate - 8;
      const left = Math.min(Math.max(8, rect.left), Math.max(8, leftMax));
      setCoords({ top, left });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (anchorRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: 'fixed',
        top: coords?.top ?? 0,
        left: coords?.left ?? 0,
        opacity: coords ? 1 : 0,
        // Slide-down entrance — the menu reads as a layer
        // dropping out from under its chip. Opacity stays gated on `coords`
        // so the pre-measured frame never flashes at the wrong spot.
        animation: 'o8ChipPopIn 130ms cubic-bezier(0.22, 1, 0.36, 1)',
        minWidth: 232,
        background: 'var(--t-popover-surface)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider, var(--t-divider-subtle))',
        borderRadius: 10,
        boxShadow: '0 12px 32px rgba(15, 23, 42, 0.22)',
        paddingTop: 4,
        paddingBottom: 4,
        zIndex: 1200,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <style>{`@keyframes o8ChipPopIn { from { transform: translateY(-6px); } to { transform: translateY(0); } }`}</style>
      {children}
    </div>,
    document.body,
  );
}

function PopoverItem({
  icon,
  label,
  selected,
  onClick,
  trailing,
  destructive,
}: {
  icon?: ReactNode;
  label: string;
  selected?: boolean;
  onClick: () => void;
  trailing?: ReactNode;
  destructive?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        gap: 10,
        paddingTop: 7,
        paddingBottom: 7,
        paddingLeft: 12,
        paddingRight: 12,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: destructive ? 'var(--t-text-muted)' : 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 12.5,
        fontWeight: 400,
        letterSpacing: '-0.005em',
        fontFamily: 'inherit',
      }}
    >
      {icon ? (
        <span style={{ flexShrink: 0, color: 'var(--t-text-faint)', display: 'inline-flex' }}>
          {icon}
        </span>
      ) : <span style={{ width: 14, flexShrink: 0 }} />}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {selected ? (
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : null}
      {trailing}
    </button>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Worktree chip
 * ────────────────────────────────────────────────────────────────────── */

function WorktreeChip({
  mode,
  onChange,
  compact,
}: {
  mode: WorktreeMode;
  onChange: (mode: WorktreeMode) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const label = mode === 'local' ? 'Work locally' : 'New worktree';
  return (
    <div ref={anchorRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <ChipShell
        icon={mode === 'local'
          ? <IconoirComputer width={13} height={13} color="currentColor" strokeWidth={1.6} />
          : <IconoirGitBranch width={13} height={13} color="currentColor" strokeWidth={1.6} />}
        label={label}
        onClick={() => setOpen((v) => !v)}
        open={open}
        ariaLabel="Start in"
        compact={compact}
      />
      <ChipPopover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef}>
        <div
          style={{
            paddingTop: 6,
            paddingBottom: 4,
            paddingLeft: 12,
            paddingRight: 12,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: 'var(--t-text-faint)',
          }}
        >
          Start in
        </div>
        <PopoverItem
          icon={<IconoirComputer width={13} height={13} color="currentColor" strokeWidth={1.6} />}
          label="Work locally"
          selected={mode === 'local'}
          onClick={() => {
            onChange('local');
            setOpen(false);
          }}
        />
        <PopoverItem
          icon={<IconoirGitBranch width={13} height={13} color="currentColor" strokeWidth={1.6} />}
          label="New worktree"
          selected={mode === 'new-worktree'}
          onClick={() => {
            onChange('new-worktree');
            setOpen(false);
          }}
        />
      </ChipPopover>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Branch chip — fetches the repo's branch list and lets the operator
 * pick one. Real branches come from /api/panel/branches?path=<repo>.
 * ────────────────────────────────────────────────────────────────────── */

function BranchChip({
  branch,
  repoPath,
  onChange,
  compact,
}: {
  branch: string;
  repoPath: string | null;
  onChange?: (branch: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean }>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !repoPath) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/panel/branches?path=${encodeURIComponent(repoPath)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: { branches?: Array<{ name: string; current: boolean }> }) => {
        if (cancelled) return;
        setBranches(data.branches ?? []);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, repoPath]);

  const interactive = Boolean(repoPath && onChange);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  return (
    <div ref={anchorRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <ChipShell
        icon={<IconoirGitBranch width={13} height={13} color="currentColor" strokeWidth={1.6} />}
        label={branch}
        onClick={interactive ? () => setOpen((v) => !v) : undefined}
        open={open}
        ariaLabel="Pick branch"
        compact={compact}
      />
      <ChipPopover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef}>
        {loading ? (
          <div style={{ padding: 12, color: 'var(--t-text-faint)', fontSize: 12 }}>Loading…</div>
        ) : branches.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--t-text-faint)', fontSize: 12 }}>
            No branches found.
          </div>
        ) : (
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {branches.map((b) => (
              <PopoverItem
                key={b.name}
                icon={<IconoirGitBranch width={13} height={13} color="currentColor" strokeWidth={1.6} />}
                label={b.name}
                selected={b.name === branch}
                onClick={() => {
                  onChange?.(b.name);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        )}
      </ChipPopover>
    </div>
  );
}
