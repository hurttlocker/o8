'use client';

/**
 * OrchestratorEmptyState — the compose-first landing for any chat-shaped
 * workspace tab that hasn't received its first message yet.
 *
 * Codex / Antigravity / Cortex pattern: instead of a generic "Good
 * morning" greeting, show the operator a dynamic question title
 * ("What should we build in o8?") + the contextual chip row
 * (Project · Worktree · Branch · Kind) above the existing composer.
 * The chips are editable until the first message lands; after that the
 * tab "promotes" and the regular transcript view takes over.
 *
 * Quick-action prompts moved BELOW the chips as inline links (no card
 * border, no bubble) so the surface reads as compose-first, not menu-
 * first.
 */

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Computer as IconoirComputer,
  Folder as IconoirFolder,
  FolderPlus as IconoirFolderPlus,
  GitBranch as IconoirGitBranch,
  InputSearch as IconoirInputSearch,
  Plus as IconoirPlus,
} from 'iconoir-react';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { OrchestratorProjectPicker } from './orchestrator/OrchestratorProjectPicker';

interface QuickAction {
  id: string;
  label: string;
  prompt: string;
}

// Three prescriptive starting points (operator 2026-07-12): fewer, bigger, clickable pills that teach the tool's core
// verbs — plan, review, triage — instead of six whisper-weight text links
// the eye skated past. Each pill sends a real prompt on click.
const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'plan',
    label: 'Start with a plan',
    prompt: 'Help me scope what to build next. Ask me what I want, then draft a tight plan we can dispatch as task packets.',
  },
  {
    id: 'review-pending',
    label: 'Review pending changes',
    prompt: 'Walk me through every pending diff waiting for approval. For each one: what repo, what the agent changed, and whether it looks safe to merge.',
  },
  {
    id: 'attention',
    label: 'What needs my attention?',
    prompt: 'Surface what needs my attention right now across agents, repos, CI, issues, and stale work. Prioritize blockers first and keep the summary tight.',
  },
];

export type WorktreeMode = 'local' | 'new-worktree';
export type OrchestratorEmptyKind = 'orchestrator' | 'chat';

interface OrchestratorEmptyStateProps {
  greeting: string;
  runtimeLabel: string;
  onActionClick: (prompt: string) => void;
  // Project picker
  repoPath: string | null;
  repoLabel: string | null;
  workspaceTargets: OrchestratorWorkspaceTarget[];
  onSelectProject?: (target: OrchestratorWorkspaceTarget) => void;
  onAddProject?: (mode?: 'scratch' | 'existing') => void;
  onWorkWithoutProject?: () => void;
  // Worktree picker
  worktreeMode: WorktreeMode;
  onWorktreeModeChange: (mode: WorktreeMode) => void;
  // Branch picker (stub — main-only for v1)
  branch: string;
  onBranchChange?: (branch: string) => void;
  // Kind picker (orchestrator vs chat). When `kindLocked` is true, the
  // chip renders read-only — e.g. llm-chat tabs that can't pivot to
  // orchestrator without spawning a new tab.
  kind: OrchestratorEmptyKind;
  kindLocked?: boolean;
  onKindChange?: (kind: OrchestratorEmptyKind) => void;
}

function OrchestratorEmptyStateBase(props: OrchestratorEmptyStateProps) {
  const { onActionClick, repoLabel, repoPath, workspaceTargets, onAddProject, kind } = props;

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
        flex: 1,
        minHeight: 0,
        // Center the title + quick-actions in the list area on BOTH axes with
        // plain flexbox. The composer rests at the bottom of the column (no
        // translate lift), so the empty state reads: centered prompt +
        // suggestions, composer below. Pure flex centering reflows correctly at
        // any workspace size — this replaces the old `28cqh` paddingTop +
        // composer `translateY` dance that overlapped whenever the panel resized.
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
          maxWidth: 640,
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

        {/* Quick action pills sit RIGHT under the title, ABOVE the
            composer (per operator pass 2026-05-27). The composer
            lifts up via -32cqh and lands just below this block, so
            the visual stack reads: title → suggestions → composer. */}
        <QuickActionPills onActionClick={onActionClick} />

        {/* Run-context chips (project · worktree · branch) moved UP here
            from below the composer (operator, 2026-07-06) — down there
            they collided with the bottom status bar. The stack reads:
            title → suggestions → context chips → composer. */}
        <div style={{ marginTop: 10 }}>
          <OrchestratorComposerBelow
            worktreeMode={props.worktreeMode}
            onWorktreeModeChange={props.onWorktreeModeChange}
            branch={props.branch}
            repoPath={repoPath}
            onBranchChange={props.onBranchChange}
            onActionClick={onActionClick}
            repoLabel={repoLabel}
            workspaceTargets={workspaceTargets}
            onSelectProject={props.onSelectProject}
            onAddProject={onAddProject}
            onWorkWithoutProject={props.onWorkWithoutProject}
          />
        </div>
      </div>
    </div>
  );
}

function QuickActionPills({ onActionClick }: { onActionClick: (prompt: string) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 8,
        maxWidth: 640,
        marginTop: 6,
      }}
    >
      {QUICK_ACTIONS.map((action) => (
        <QuickActionPill key={action.id} label={action.label} onClick={() => onActionClick(action.prompt)} />
      ))}
    </div>
  );
}

// Pill-shaped suggestion button — same chip vocabulary as ChipShell below
// (hairline border, full radius, hover fill) but a step larger so it reads
// as an action, not run-context.
function QuickActionPill({ label, onClick }: { label: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        paddingTop: 7,
        paddingBottom: 7,
        paddingLeft: 14,
        paddingRight: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        borderRadius: 999,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: hovered ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 12,
        fontWeight: 400,
        letterSpacing: '-0.005em',
        whiteSpace: 'nowrap',
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      {label}
    </button>
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
 * OrchestratorComposerBelow — the Worktree / Branch / Kind chip row
 * that renders BELOW the composer input on the compose-first empty
 * state (Antigravity / Cortex pattern). The Project chip stays above
 * the composer; these three sit under it, so the operator's eye flows
 * title → project → composer → run-context.
 */
interface OrchestratorComposerBelowProps {
  worktreeMode: WorktreeMode;
  onWorktreeModeChange: (mode: WorktreeMode) => void;
  branch: string;
  repoPath: string | null;
  onBranchChange?: (branch: string) => void;
  onActionClick: (prompt: string) => void;
  // Project chip (moved here from the heading row per operator
  // request 2026-05-27 — sits to the right of Worktree).
  repoLabel?: string | null;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  onSelectProject?: (target: OrchestratorWorkspaceTarget) => void;
  onAddProject?: (mode?: 'scratch' | 'existing') => void;
  onWorkWithoutProject?: () => void;
}

// Below this available width the chip row collapses every chip to an
// icon-only trigger (Codex/Cursor adaptive behavior). Measured, not a
// viewport media query, so it tracks the real panel size.
const COMPACT_CHIP_ROW_WIDTH = 440;

function OrchestratorComposerBelowBase(props: OrchestratorComposerBelowProps) {
  // Adaptive chip row (operator pass 2026-06-14): a ResizeObserver on the
  // row's available width drops every chip's label when the workspace
  // narrows, so the chips become icons that adapt to split panes / window
  // resize instead of wrapping. Measurement keeps us on the inline-styles
  // path (no container-query CSS / classes).
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setCompact(w < COMPACT_CHIP_ROW_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={rowRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
        gap: 14,
        paddingTop: 8,
        paddingBottom: 4,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {props.workspaceTargets ? (
          <ProjectChip
            label={props.repoPath === '~' ? '~' : (props.repoLabel ?? 'No project')}
            workspaceTargets={props.workspaceTargets}
            selectedRepoPath={props.repoPath}
            onSelectProject={props.onSelectProject}
            onAddProject={props.onAddProject}
            onWorkWithoutProject={props.onWorkWithoutProject}
            compact={compact}
          />
        ) : null}
        <WorktreeChip mode={props.worktreeMode} onChange={props.onWorktreeModeChange} compact={compact} />
        {/* Branch chip is adaptive: only shown when starting in a NEW
            worktree (where the branch is the base for the new tree).
            Working locally inherits the current checkout, which the footer
            status bar already shows — so we drop the redundant second
            branch pill (the "two mains" the operator flagged). */}
        {props.worktreeMode === 'new-worktree' ? (
          <BranchChip branch={props.branch} repoPath={props.repoPath} onChange={props.onBranchChange} compact={compact} />
        ) : null}
      </div>
      {/* QUICK_ACTIONS pills moved into OrchestratorEmptyState (above the
          composer) per operator pass 2026-05-27. Composer chip row only
          carries run-context selectors now. */}
    </div>
  );
}

export const OrchestratorComposerBelow = memo(OrchestratorComposerBelowBase);

export function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning.';
  if (hour < 17) return 'Good afternoon.';
  return 'Good evening.';
}

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
        background: 'var(--t-panel-solid, var(--t-panel))',
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

function PopoverDivider() {
  return (
    <div
      aria-hidden
      style={{
        height: 1,
        background: 'var(--t-divider-subtle)',
        marginTop: 4,
        marginBottom: 4,
        marginLeft: 8,
        marginRight: 8,
      }}
    />
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Project chip + popover
 * ────────────────────────────────────────────────────────────────────── */

function ProjectChip({
  label,
  workspaceTargets,
  selectedRepoPath,
  onSelectProject,
  onAddProject,
  onWorkWithoutProject,
  compact,
}: {
  label: string;
  workspaceTargets: OrchestratorWorkspaceTarget[];
  selectedRepoPath: string | null;
  onSelectProject?: (target: OrchestratorWorkspaceTarget) => void;
  onAddProject?: (mode?: 'scratch' | 'existing') => void;
  onWorkWithoutProject?: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const searchId = useId();

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workspaceTargets;
    return workspaceTargets.filter((target) => (
      target.repoName.toLowerCase().includes(q) || target.localPath.toLowerCase().includes(q)
    ));
  }, [query, workspaceTargets]);

  return (
    <div ref={wrapperRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <ChipShell
        icon={<IconoirFolder width={13} height={13} color="currentColor" strokeWidth={1.6} />}
        label={label}
        onClick={() => setOpen((v) => !v)}
        open={open}
        ariaLabel="Pick project"
        compact={compact}
      />
      <ChipPopover open={open} onClose={() => setOpen(false)} anchorRef={wrapperRef}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 8,
            paddingBottom: 4,
            paddingLeft: 12,
            paddingRight: 12,
          }}
        >
          <IconoirInputSearch width={12} height={12} color="var(--t-text-faint)" strokeWidth={1.6} />
          <input
            id={searchId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects"
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              borderWidth: 0,
              outline: 'none',
              color: 'var(--t-text)',
              fontFamily: 'inherit',
              fontSize: 12.5,
              padding: 0,
            }}
          />
        </div>
        <div style={{ maxHeight: 240, overflowY: 'auto' }}>
          {filtered.map((target) => (
            <PopoverItem
              key={target.id}
              icon={<IconoirFolder width={13} height={13} color="currentColor" strokeWidth={1.6} />}
              label={target.repoName}
              selected={target.localPath === selectedRepoPath}
              onClick={() => {
                onSelectProject?.(target);
                setOpen(false);
              }}
            />
          ))}
          {filtered.length === 0 ? (
            <div style={{ padding: 12, color: 'var(--t-text-faint)', fontSize: 12 }}>
              No projects match.
            </div>
          ) : null}
        </div>
        <PopoverDivider />
        <div
          style={{ position: 'relative' }}
          onMouseEnter={() => setAddOpen(true)}
          onMouseLeave={() => setAddOpen(false)}
        >
          <PopoverItem
            icon={<IconoirFolderPlus width={13} height={13} color="currentColor" strokeWidth={1.6} />}
            label="Add new project"
            onClick={() => setAddOpen((v) => !v)}
            trailing={(
              <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: 'var(--t-text-faint)' }}>
                <path d="M9 6l6 6-6 6" />
              </svg>
            )}
          />
          {addOpen ? (
            <div
              role="menu"
              style={{
                position: 'absolute',
                top: 0,
                left: '100%',
                marginLeft: 4,
                minWidth: 200,
                background: 'var(--t-panel)',
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider)',
                borderRadius: 10,
                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.22)',
                paddingTop: 4,
                paddingBottom: 4,
                zIndex: 70,
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              <PopoverItem
                icon={<IconoirPlus width={13} height={13} color="currentColor" strokeWidth={1.6} />}
                label="Start from scratch"
                onClick={() => {
                  onAddProject?.('scratch');
                  setAddOpen(false);
                  setOpen(false);
                }}
              />
              <PopoverItem
                icon={<IconoirFolder width={13} height={13} color="currentColor" strokeWidth={1.6} />}
                label="Use an existing folder"
                onClick={() => {
                  onAddProject?.('existing');
                  setAddOpen(false);
                  setOpen(false);
                }}
              />
            </div>
          ) : null}
        </div>
        <PopoverItem
          icon={<IconoirFolder width={13} height={13} color="currentColor" strokeWidth={1.6} />}
          label="Don't work in a project"
          destructive
          onClick={() => {
            onWorkWithoutProject?.();
            setOpen(false);
          }}
        />
      </ChipPopover>
    </div>
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
