'use client';

/**
 * OrchestratorEmptyState — the compose-first landing for any chat-shaped
 * workspace tab that hasn't received its first message yet.
 *
 * Codex / Antigravity / Cortex pattern: instead of a generic "Good
 * morning" greeting, show the operator a dynamic question title
 * ("What should we build in cortex-ide?") + the contextual chip row
 * (Project · Worktree · Branch · Kind) above the existing composer.
 * The chips are editable until the first message lands; after that the
 * tab "promotes" and the regular transcript view takes over.
 *
 * Quick-action prompts moved BELOW the chips as inline links (no card
 * border, no bubble) so the surface reads as compose-first, not menu-
 * first.
 */

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Computer as IconoirComputer,
  Folder as IconoirFolder,
  FolderPlus as IconoirFolderPlus,
  GitBranch as IconoirGitBranch,
  InputSearch as IconoirInputSearch,
  Plus as IconoirPlus,
  Settings as IconoirSettings,
} from 'iconoir-react';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';

interface QuickAction {
  id: string;
  label: string;
  prompt: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'review-pending',
    label: 'Review pending agent changes',
    prompt: 'Walk me through every pending diff waiting for approval. For each one: what repo, what the agent changed, and whether it looks safe to merge.',
  },
  {
    id: 'ship-status',
    label: 'What did agents ship today?',
    prompt: 'Summarize everything that merged into main today across all agents. Group by repo, highlight anything risky, and tell me the overall momentum.',
  },
  {
    id: 'token-spend',
    label: "Audit today's token spend",
    prompt: "Audit today's token spend across every agent and model. Break down what spent the most, what looks unusual, and what I should change if anything is wasteful.",
  },
  {
    id: 'dispatch',
    label: 'Dispatch a task',
    prompt: 'Help me scope a task to dispatch. Ask me what repo and what needs to happen, then draft a tight, one-paragraph task packet I can send.',
  },
  {
    id: 'recent-changes',
    label: 'Review the most recent changes',
    prompt: 'Review the most recent changes across the active repos. Summarize the commits, call out possible issues, and tell me what should be checked before merging more work.',
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
  // Kind picker (orchestrator vs chat). When `kindLocked` is true, the
  // chip renders read-only — e.g. llm-chat tabs that can't pivot to
  // orchestrator without spawning a new tab.
  kind: OrchestratorEmptyKind;
  kindLocked?: boolean;
  onKindChange?: (kind: OrchestratorEmptyKind) => void;
}

function OrchestratorEmptyStateBase(props: OrchestratorEmptyStateProps) {
  const {
    onActionClick,
    repoLabel,
    workspaceTargets,
    onSelectProject,
    onAddProject,
    onWorkWithoutProject,
    worktreeMode,
    onWorktreeModeChange,
    branch,
    kind,
    kindLocked,
    onKindChange,
  } = props;

  const titleProject = repoLabel ?? 'your workspace';
  const title = `What should we build in ${titleProject}?`;

  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        alignItems: 'flex-start',
        justifyContent: 'center',
        // Title + Project chip pinned to the top of the empty area so
        // the composer (which translates upward from its bottom resting
        // position) lands in the middle of the canvas WITHOUT overlapping
        // the title. The composer's translateY value and this padding
        // together establish the visual rhythm: top header → composer
        // (lifted middle) → below-composer chips + actions.
        paddingTop: '14vh',
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
            // Match the sidebar's lighter-weight hierarchy (Hurttlocker
            // spec: title weight 300, tight tracking). The sidebar
            // family already lives at `var(--font-sans-system)`.
            fontSize: 30,
            fontWeight: 300,
            color: 'var(--t-text)',
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
            fontFamily: 'var(--font-sans-system)',
            textAlign: 'center',
            margin: 0,
          }}
        >
          {title}
        </h1>

        {/* Project chip ABOVE the composer — Antigravity / Cortex
            pattern. The Worktree / Branch / Kind chips live BELOW the
            composer input (rendered inside ThoughtsChatPanel's lift
            wrapper) so the composer chrome doesn't duplicate them. */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            width: '100%',
          }}
        >
          <ProjectChip
            label={repoLabel ?? 'No project'}
            workspaceTargets={workspaceTargets}
            selectedRepoPath={props.repoPath}
            onSelectProject={onSelectProject}
            onAddProject={onAddProject}
            onWorkWithoutProject={onWorkWithoutProject}
          />
        </div>

        {/* Inline quick action pills now render in OrchestratorComposerBelow
            (below the composer + chip row) so they sit in their natural
            visible position once the composer slides up. */}
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
  kind: OrchestratorEmptyKind;
  kindLocked?: boolean;
  onKindChange?: (kind: OrchestratorEmptyKind) => void;
  onActionClick: (prompt: string) => void;
}

function OrchestratorComposerBelowBase(props: OrchestratorComposerBelowProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
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
        <WorktreeChip mode={props.worktreeMode} onChange={props.onWorktreeModeChange} />
        <BranchChip branch={props.branch} repoPath={props.repoPath} onChange={props.onBranchChange} />
        <KindChip kind={props.kind} locked={props.kindLocked} onChange={props.onKindChange} />
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          columnGap: 11,
          rowGap: 5,
          maxWidth: 640,
        }}
      >
        {QUICK_ACTIONS.map((action, index) => (
          <span
            key={action.id}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              // Match the sidebar's meta-text weight (Hurttlocker spec:
              // 9.5px / 260 / -0.4) — these are quiet suggestion text,
              // smaller than the chip row above so the eye flows
              // composer → chips → pills as a clear hierarchy.
              fontSize: 10,
              fontWeight: 320,
              letterSpacing: '-0.005em',
              color: 'var(--t-text-muted)',
            }}
          >
            <button
              type="button"
              onClick={() => props.onActionClick(action.prompt)}
              style={{
                background: 'transparent',
                borderWidth: 0,
                padding: 0,
                fontFamily: 'inherit',
                fontSize: 'inherit',
                color: 'var(--t-text-secondary)',
                cursor: 'pointer',
                letterSpacing: '-0.005em',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-secondary)'; }}
            >
              {action.label}
            </button>
            {index < QUICK_ACTIONS.length - 1 ? (
              <span aria-hidden style={{ color: 'var(--t-text-faint)' }}>·</span>
            ) : null}
          </span>
        ))}
      </div>
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

function ChipShell({
  icon,
  label,
  onClick,
  open,
  ariaLabel,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  open?: boolean;
  ariaLabel?: string;
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
      aria-haspopup={isInteractive ? 'menu' : undefined}
      aria-expanded={isInteractive ? Boolean(open) : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 10,
        paddingRight: 10,
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
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
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

/** Popover anchored to the chip below, click-outside dismiss. */
function ChipPopover({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(event.target as Node)) onClose();
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
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        minWidth: 232,
        background: 'var(--t-panel)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.22)',
        paddingTop: 4,
        paddingBottom: 4,
        zIndex: 60,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      {children}
    </div>
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
}: {
  label: string;
  workspaceTargets: OrchestratorWorkspaceTarget[];
  selectedRepoPath: string | null;
  onSelectProject?: (target: OrchestratorWorkspaceTarget) => void;
  onAddProject?: (mode?: 'scratch' | 'existing') => void;
  onWorkWithoutProject?: () => void;
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
      />
      <ChipPopover open={open} onClose={() => setOpen(false)}>
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
}: {
  mode: WorktreeMode;
  onChange: (mode: WorktreeMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = mode === 'local' ? 'Work locally' : 'New worktree';
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <ChipShell
        icon={<IconoirComputer width={13} height={13} color="currentColor" strokeWidth={1.6} />}
        label={label}
        onClick={() => setOpen((v) => !v)}
        open={open}
        ariaLabel="Pick worktree mode"
      />
      <ChipPopover open={open} onClose={() => setOpen(false)}>
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
}: {
  branch: string;
  repoPath: string | null;
  onChange?: (branch: string) => void;
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

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <ChipShell
        icon={<IconoirGitBranch width={13} height={13} color="currentColor" strokeWidth={1.6} />}
        label={branch}
        onClick={interactive ? () => setOpen((v) => !v) : undefined}
        open={open}
        ariaLabel="Pick branch"
      />
      <ChipPopover open={open} onClose={() => setOpen(false)}>
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

/* ──────────────────────────────────────────────────────────────────────
 * Kind chip — Orchestrator vs Chat
 * ────────────────────────────────────────────────────────────────────── */

function KindChip({
  kind,
  locked,
  onChange,
}: {
  kind: OrchestratorEmptyKind;
  locked?: boolean;
  onChange?: (kind: OrchestratorEmptyKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = kind === 'chat' ? 'Chat' : 'Orchestrator';
  const interactive = !locked && Boolean(onChange);
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <ChipShell
        icon={<IconoirSettings width={13} height={13} color="currentColor" strokeWidth={1.6} />}
        label={label}
        onClick={interactive ? () => setOpen((v) => !v) : undefined}
        open={open}
        ariaLabel="Pick conversation kind"
      />
      <ChipPopover open={open} onClose={() => setOpen(false)}>
        <PopoverItem
          icon={<IconoirSettings width={13} height={13} color="currentColor" strokeWidth={1.6} />}
          label="Orchestrator"
          selected={kind === 'orchestrator'}
          onClick={() => {
            onChange?.('orchestrator');
            setOpen(false);
          }}
        />
        <PopoverItem
          icon={<IconoirPlus width={13} height={13} color="currentColor" strokeWidth={1.6} />}
          label="Chat"
          selected={kind === 'chat'}
          onClick={() => {
            onChange?.('chat');
            setOpen(false);
          }}
        />
      </ChipPopover>
    </div>
  );
}
