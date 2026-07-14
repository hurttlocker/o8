'use client';

import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { SmoothCorners } from '@lisse/react';
import { CollapsedRailIcon, ChevronsLeftIcon, ChevronsRightIcon } from './branch-rail-collapse';
import {
  COLLAPSED_BRANCH_RAIL_CAPSULE_RADIUS,
  COLLAPSED_BRANCH_RAIL_CAPSULE_WIDTH,
  COLLAPSED_BRANCH_RAIL_INSET,
  COLLAPSED_BRANCH_RAIL_WIDTH,
  WORKSPACE_RAIL_CORNER_SMOOTHING,
} from './branch-rail-geometry';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { useWorkspaceChanges } from './o8-panel/workspace-rail/ChangesList';
import { useBranchPr } from './useBranchPr';
import { usePrDetail } from './pr-panel/usePrDetail';
import type { PrCheck } from './pr-panel/types';
import type { OrchestratorPacket, OrchestratorRuntime, OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';

const ROW_HEIGHT = 28;
const CHECK_ROW_HEIGHT = 24;

function normalizePath(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.replace(/\/+$/, '');
}

function pickActivePacket(packets: OrchestratorPacket[] | undefined, selectedId: string | null | undefined): OrchestratorPacket | null {
  if (!packets || packets.length === 0) return null;
  if (selectedId) {
    const hit = packets.find((p) => p.id === selectedId);
    if (hit) return hit;
  }
  const priority: Record<string, number> = {
    awaiting_review: 4,
    running: 3,
    dispatched: 2,
    blocked: 1,
  };
  const ranked = [...packets].sort((a, b) => (priority[b.status] ?? 0) - (priority[a.status] ?? 0));
  const top = ranked[0];
  if (!top) return null;
  if ((priority[top.status] ?? 0) === 0) return null;
  return top;
}

/**
 * Repo-scoped picker (#cross-repo-rail): the rail is mounted inside EVERY
 * orchestrator tab, and each tab hosts a session in a specific repo. Without
 * scoping, `pickActivePacket` returned the highest-priority packet anywhere in
 * the fleet, so tabs in different repos all rendered the same (foreign) branch,
 * Changes count, worker, and PR. Filter to this tab's repo BEFORE picking so a
 * `selectedPacketId` is only honored when the selected packet belongs here, and
 * the fallback priority pick stays within the repo. No `repoPath` (defensive)
 * → legacy global behavior.
 */
export function pickActivePacketForRepo(
  packets: OrchestratorPacket[] | undefined,
  selectedId: string | null | undefined,
  repoPath: string | null | undefined,
): OrchestratorPacket | null {
  if (!packets || packets.length === 0) return null;
  const normRepo = normalizePath(repoPath);
  if (!normRepo) return pickActivePacket(packets, selectedId);
  const scoped = packets.filter((p) => normalizePath(p.workspaceTargetPath) === normRepo);
  if (scoped.length === 0) return null;
  return pickActivePacket(scoped, selectedId);
}

function runtimeLabel(runtime: OrchestratorRuntime | string | undefined) {
  if (!runtime) return 'Codex';
  if (runtime === 'claude-code') return 'Claude';
  if (runtime === 'opencode') return 'OpenCode';
  return runtime.charAt(0).toUpperCase() + runtime.slice(1);
}

function pickTarget(
  activePacket: OrchestratorPacket | null,
  targets: OrchestratorWorkspaceTarget[] | undefined,
  repoPath: string | null | undefined,
): OrchestratorWorkspaceTarget | null {
  if (!targets || targets.length === 0) return null;
  const normRepo = normalizePath(repoPath);
  if (normRepo) {
    // Repo-scoped: only ever resolve a target that belongs to this tab's repo —
    // never fall back to another repo's target (the global `targets[0]`).
    return targets.find((target) => normalizePath(target.localPath) === normRepo) ?? null;
  }
  // Legacy global behavior (no repoPath prop).
  if (activePacket?.workspaceTargetPath) {
    const hit = targets.find((target) => target.localPath === activePacket.workspaceTargetPath);
    if (hit) return hit;
  }
  return targets[0] ?? null;
}

export function BranchDetailsLauncher({ visible = true, repoPath = null, collapsed = false, onToggleCollapsed }: {
  visible?: boolean;
  repoPath?: string | null;
  /** Codex-style fold: inset icon column instead of the full 256px card stack. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const data = useOrchestratorData();
  const [progressOpen, setProgressOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(true);

  const activePacket = useMemo(
    () => pickActivePacketForRepo(data?.missionState?.packets, data?.selectedPacketId, repoPath),
    [data?.missionState?.packets, data?.selectedPacketId, repoPath],
  );

  const activeTarget = useMemo(
    () => pickTarget(activePacket, data?.workspaceTargets ?? [], repoPath),
    [activePacket, data?.workspaceTargets, repoPath],
  );

  const branch = activePacket?.branchTarget || activeTarget?.branch || 'main';
  // Fall back to the tab's own repoPath (the prop) when there's no active packet
  // or matching target, so the hooks below stay scoped to THIS repo's local
  // state instead of resolving nothing (or, pre-scoping, a foreign repo).
  const resolvedRepoPath = activePacket?.workspaceTargetPath ?? activeTarget?.localPath ?? repoPath ?? null;
  const changes = useWorkspaceChanges(resolvedRepoPath);
  // PR for the current branch, surfaced inline so the operator sees status
  // without opening the PRs tab (Q ruling 2026-07-11). Keyed by repo NAME (the
  // list API resolves slug/name, not a local path). Null on main/master or
  // when no open PR points at the branch.
  const prRepoIdent = activeTarget?.repoName
    ?? (resolvedRepoPath ? resolvedRepoPath.split('/').filter(Boolean).pop() ?? null : null);
  const branchPr = useBranchPr(prRepoIdent, branch);
  const { detail: prDetail } = usePrDetail(branchPr?.number ?? null, branchPr?.repoSlug ?? null);

  // Coexists with the wide O8 panel now (Q ruling 2026-07-11) — no longer
  // self-hides when it's open; the caller's railFits gating handles space.
  if (!data || !visible) return null;

  const prChecks = summarizePrChecks(prDetail?.statusCheckRollup ?? []);
  const prCommentCount = prDetail
    ? prDetail.issueComments.length + prDetail.reviewComments.length
    : 0;

  const packetRuntime = activePacket?.runtime ?? data.agents.find((agent) => agent.status === 'running' || agent.currentTask)?.runtime;
  const subagentLabel = activePacket
    ? runtimeLabel(activePacket.runtime)
    : data.agents.find((agent) => agent.currentTask || agent.status === 'running')?.name;
  const progressRows = buildProgressRows(activePacket, activeTarget, branch);
  const hasDiff = changes.totalAdditions > 0 || changes.totalDeletions > 0;

  const open = (tab: NonNullable<Parameters<NonNullable<typeof data.onOpenO8Panel>>[0]['tab']>) => {
    data.onOpenO8Panel?.({ repoPath: resolvedRepoPath, tab });
  };

  // Collapsed — an inset icon column (Codex parity, Q 2026-07-13): one icon per
  // card, « to expand below the stack. Icons act as jump-ins: browser opens
  // the Browser tab directly; the rest expand the rail.
  if (collapsed) {
    return (
      <aside
        className="hide-scrollbar"
        style={{
          width: COLLAPSED_BRANCH_RAIL_WIDTH,
          height: '100%',
          flexShrink: 0,
          paddingTop: COLLAPSED_BRANCH_RAIL_INSET,
          paddingRight: COLLAPSED_BRANCH_RAIL_INSET,
          paddingBottom: 12,
          paddingLeft: COLLAPSED_BRANCH_RAIL_INSET,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          minHeight: 0,
          overflowY: 'auto',
          scrollbarWidth: 'none',
        }}
      >
        {/* Codex parity: the collapsed icons sit on a rounded drawer capsule. */}
        <SmoothCorners
          corners={{ radius: COLLAPSED_BRANCH_RAIL_CAPSULE_RADIUS, smoothing: WORKSPACE_RAIL_CORNER_SMOOTHING }}
          innerBorder={{ width: 1, color: 'var(--t-divider-subtle)', opacity: 1 }}
          autoEffects={false}
          style={{
            width: COLLAPSED_BRANCH_RAIL_CAPSULE_WIDTH,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0,
            paddingTop: 5,
            paddingBottom: 5,
            paddingLeft: 4,
            paddingRight: 4,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'transparent',
            background: 'var(--t-bg-card)',
            flexShrink: 0,
          }}>
        <CollapsedRailIcon title="Expand" onClick={() => onToggleCollapsed?.()}><ChevronsLeftIcon /></CollapsedRailIcon>
        <CollapsedRailIcon title="Progress" onClick={() => onToggleCollapsed?.()}><ChecksIcon /></CollapsedRailIcon>
        <CollapsedRailIcon title="Environment" onClick={() => onToggleCollapsed?.()}><DiffIcon /></CollapsedRailIcon>
        {prDetail ? (
          <CollapsedRailIcon title={`Pull request #${prDetail.number}`} onClick={() => open('prs')}><GhIcon /></CollapsedRailIcon>
        ) : null}
        <CollapsedRailIcon title="Subagents" onClick={() => onToggleCollapsed?.()}><WorkerIcon /></CollapsedRailIcon>
        <CollapsedRailIcon title="Browser" onClick={() => open('browser')}><GlobeIcon /></CollapsedRailIcon>
        <CollapsedRailIcon title="Sources" onClick={() => onToggleCollapsed?.()}><SquaresIcon /></CollapsedRailIcon>
        </SmoothCorners>
      </aside>
    );
  }

  return (
    <aside
      className="hide-scrollbar"
      style={{
        width: 256,
        height: '100%',
        flexShrink: 0,
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 14,
        paddingLeft: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 0,
        overflowY: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {/* Collapse control sits below the window header, right-aligned — the
          » folds the rail to the icon column (Codex parity, Q video). */}
      {onToggleCollapsed ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <CollapsedRailIcon title="Collapse" onClick={onToggleCollapsed}><ChevronsRightIcon /></CollapsedRailIcon>
        </div>
      ) : null}
      <Card>
        <SectionHeader
          label="Progress"
          hint={activePacket?.referenceLabel ?? activeTarget?.label ?? 'Workspace'}
          open={progressOpen}
          onClick={() => setProgressOpen((value) => !value)}
        />
        {progressOpen ? (
          <div style={{ paddingTop: 2, paddingBottom: 4 }}>
            {progressRows.map((row) => (
              <ProgressRow key={row.label} label={row.label} done={row.done} muted={row.muted} />
            ))}
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionHeader
          label="Environment"
          open={environmentOpen}
          onClick={() => setEnvironmentOpen((value) => !value)}
          metric={hasDiff ? <DiffStats additions={changes.totalAdditions} deletions={changes.totalDeletions} /> : null}
          action={<GearIcon />}
        />
        {environmentOpen ? (
          <div style={{ paddingTop: 2, paddingBottom: 3 }}>
            <Row icon={<DiffIcon />} label="Changes" detail={changes.files.length > 0 ? `${changes.files.length}` : undefined} onClick={() => open('workspace')} />
            <Row icon={<LaptopIcon />} label="Local" onClick={() => open('workspace')} />
            <Row icon={<BranchIcon />} label={branch} onClick={() => open('workspace')} />
            <Row icon={<CommitIcon />} label="Commit" onClick={() => open('workspace')} />
            <Row icon={<GhIcon />} label="Create pull request" onClick={() => open('prs')} />
          </div>
        ) : null}
      </Card>

      {prDetail ? (
        <Card>
          <StaticHeader label="Pull request" />
          <Row
            icon={<GhIcon />}
            label={`#${prDetail.number} ${prDetail.title}`}
            onClick={() => open('prs')}
          />
          <Row
            icon={<DiffIcon />}
            label={`+${prDetail.additions} −${prDetail.deletions}`}
            detail={`${prDetail.changedFiles} file${prDetail.changedFiles === 1 ? '' : 's'}`}
            onClick={() => open('prs')}
          />
          {!prDetail.mergeable ? (
            <Row icon={<ConflictIcon />} label="Conflicts with base" tone="danger" onClick={() => open('prs')} />
          ) : null}
          {prChecks ? (
            prChecks.danger ? (
              <Row icon={<ChecksIcon />} label={prChecks.label} tone="danger" onClick={() => open('prs')} />
            ) : (
              <StaticRow icon={<ChecksIcon />} label={prChecks.label} />
            )
          ) : null}
          {prCommentCount > 0 ? (
            <Row
              icon={<CommentIcon />}
              label={`${prCommentCount} comment${prCommentCount === 1 ? '' : 's'}`}
              onClick={() => open('prs')}
            />
          ) : null}
        </Card>
      ) : null}

      <Card>
        <StaticHeader label="Subagents" />
        {subagentLabel ? (
          <Row
            icon={<WorkerIcon />}
            label={`${subagentLabel} (worker)`}
            onClick={() => {
              if (activePacket?.lane?.sessionKey) data.onSelectSession?.(activePacket.lane.sessionKey);
            }}
            tone={activePacket?.status === 'blocked' || activePacket?.status === 'failed' ? 'danger' : undefined}
          />
        ) : (
          <StaticRow icon={<WorkerIcon />} label="No active subagents" muted />
        )}
      </Card>

      <Card>
        <StaticHeader label="Browser" />
        <Row icon={<GlobeIcon />} label="o8" detail={typeof window === 'undefined' ? undefined : window.location.host} onClick={() => open('browser')} />
      </Card>

      <Card>
        <StaticHeader label="Sources" />
        <StaticRow icon={<SquaresIcon />} label="O8" muted />
        <Row icon={<SquaresIcon />} label="Playwright" onClick={() => open('browser')} muted />
        <Row icon={<SquaresIcon />} label="Chrome Devtools" onClick={() => open('browser')} muted />
        <StaticRow icon={<GlobeIcon />} label="Web search" muted />
      </Card>

      <span style={{ display: 'none' }} aria-hidden data-runtime={runtimeLabel(packetRuntime)} />
    </aside>
  );
}

function buildProgressRows(
  activePacket: OrchestratorPacket | null,
  activeTarget: OrchestratorWorkspaceTarget | null,
  branch: string,
) {
  if (!activePacket) {
    return [
      { label: `${activeTarget?.label ?? 'Workspace'} selected`, done: true, muted: false },
      { label: `Branch ${branch}`, done: true, muted: false },
      { label: 'No active packet', done: false, muted: true },
    ];
  }

  return [
    { label: activePacket.title || activePacket.referenceLabel, done: true, muted: false },
    { label: activePacket.status.replace(/_/g, ' '), done: activePacket.status !== 'blocked' && activePacket.status !== 'failed', muted: false },
    { label: activePacket.lastEventLabel || `Branch ${branch}`, done: true, muted: !activePacket.lastEventLabel },
  ];
}

function summarizePrChecks(rollup: PrCheck[]): { label: string; danger: boolean } | null {
  if (!rollup || rollup.length === 0) return null;
  const failing = rollup.filter((c) => ['failure', 'error', 'cancelled', 'timed_out', 'action_required'].includes((c.conclusion ?? '').toLowerCase())).length;
  if (failing > 0) return { label: `${failing} check${failing === 1 ? '' : 's'} failing`, danger: true };
  const pending = rollup.some((c) => ['in_progress', 'queued', 'pending', 'waiting', 'requested'].includes((c.status ?? '').toLowerCase()));
  if (pending) return { label: 'Checks running', danger: false };
  return { label: 'All checks passed', danger: false };
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'color-mix(in srgb, var(--t-border-subtle, var(--t-border)) 55%, transparent)',
        background: 'color-mix(in srgb, var(--t-bg-card) 70%, transparent)',
        paddingTop: 6,
        paddingBottom: 4,
        paddingLeft: 4,
        paddingRight: 4,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>
  );
}

function StaticHeader({
  label,
}: {
  label: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: 22,
        paddingLeft: 10,
        paddingRight: 10,
        paddingBottom: 4,
        fontSize: 10,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        lineHeight: '14px',
        color: 'var(--t-text-faint)',
      }}
    >
      {label}
    </div>
  );
}

function SectionHeader({
  label,
  hint,
  action,
  metric,
  open,
  onClick,
}: {
  label: string;
  hint?: string;
  action?: ReactNode;
  metric?: ReactNode;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        minHeight: 24,
        paddingLeft: 10,
        paddingRight: 10,
        paddingTop: 0,
        paddingBottom: 4,
        border: 0,
        borderRadius: 8,
        background: 'transparent',
        fontSize: 10,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        lineHeight: '14px',
        color: 'var(--t-text-faint)',
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'color-mix(in srgb, var(--t-text-muted) 7%, transparent)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span>{label}</span>
      <span
        style={{
          display: 'inline-flex',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)',
          color: 'var(--t-text-muted)',
          opacity: 0.8,
        }}
      >
        <ChevronIcon />
      </span>
      {hint ? (
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            color: 'var(--t-text-faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            flex: 1,
            textAlign: 'right',
          }}
          title={hint}
        >
          {hint}
        </span>
      ) : null}
      {metric ? (
        <span style={{ marginLeft: 'auto', display: 'inline-flex' }}>
          {metric}
        </span>
      ) : null}
      {action ? (
        <span
          onClick={(event) => event.stopPropagation()}
          style={{ display: 'inline-flex', color: 'var(--t-text-muted)' }}
        >
          {action}
        </span>
      ) : null}
    </button>
  );
}

function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 9.5,
        fontWeight: 300,
        letterSpacing: '-0.2px',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span style={{ color: 'var(--t-terminal-ansi-bright-green, #22c55e)' }}>+{additions}</span>
      <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>-{deletions}</span>
    </span>
  );
}

function ProgressRow({ label, done, muted }: { label: string; done: boolean; muted?: boolean }) {
  return (
    <div
      style={{
        minHeight: CHECK_ROW_HEIGHT,
        paddingLeft: 10,
        paddingRight: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        color: muted ? 'var(--t-text-faint)' : 'var(--t-text)',
        fontSize: 13.5,
        fontWeight: 300,
        lineHeight: 1.25,
        letterSpacing: '-0.1px',
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 999,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: done ? 'var(--t-bg-card)' : 'var(--t-text-faint)',
          background: done
            ? 'color-mix(in srgb, var(--t-text-muted) 72%, transparent)'
            : 'color-mix(in srgb, var(--t-text-muted) 10%, transparent)',
        }}
      >
        {done ? <CheckIcon /> : null}
      </span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </div>
  );
}

const ROW_BASE: CSSProperties = {
  height: ROW_HEIGHT,
  paddingLeft: 10,
  paddingRight: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  borderRadius: 8,
  borderWidth: 0,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 13.5,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  lineHeight: 1.25,
  color: 'var(--t-text)',
  fontFamily: 'inherit',
};

function Row({
  icon,
  label,
  detail,
  onClick,
  muted = false,
  tone,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  onClick: () => void;
  muted?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      onClick={onClick}
      style={{
        ...ROW_BASE,
        color: tone === 'danger' ? '#dc2626' : muted ? 'var(--t-text-muted)' : 'var(--t-text)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--t-panel-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0, color: muted ? 'var(--t-text-muted)' : 'var(--t-text-secondary)' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {detail ? <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', whiteSpace: 'nowrap' }}>{detail}</span> : null}
    </button>
  );
}

function StaticRow({ icon, label, muted = false }: { icon: ReactNode; label: string; muted?: boolean }) {
  return (
    <div
      style={{
        ...ROW_BASE,
        cursor: 'default',
        color: muted ? 'var(--t-text-muted)' : 'var(--t-text)',
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0, color: 'var(--t-text-muted)' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
}

function svgProps(size = 15): { width: number; height: number; viewBox: string; fill: string; stroke: string; strokeWidth: number; strokeLinecap: 'round'; strokeLinejoin: 'round' } {
  return { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };
}

function DiffIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function LaptopIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="4" y="5" width="16" height="11" rx="2" />
      <path d="M3 19h18" />
      <path d="M8 16h8" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 8v8" />
      <path d="M18 10v2a4 4 0 0 1-4 4H8" />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M3 12h6" />
      <circle cx="12" cy="12" r="3" />
      <path d="M15 12h6" />
    </svg>
  );
}

function WorkerIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="7" y="4" width="10" height="8" rx="3" />
      <circle cx="9.5" cy="8" r=".6" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="8" r=".6" fill="currentColor" stroke="none" />
      <path d="M8 18a4 4 0 0 1 8 0" />
      <path d="M12 12v2" />
    </svg>
  );
}

function GhIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M9 19c-4 1.5-4-2-6-2" />
      <path d="M15 21v-3.4a3 3 0 0 0-.84-2.32C17.06 14.92 19 13.46 19 9.5a4.65 4.65 0 0 0-.88-3 4.3 4.3 0 0 0-.12-3s-1-.32-3.3 1.24a11.4 11.4 0 0 0-6 0C6.4 3.16 5.4 3.5 5.4 3.5a4.3 4.3 0 0 0-.12 3A4.65 4.65 0 0 0 4.4 9.5c0 3.95 1.93 5.42 4.84 5.78A3 3 0 0 0 8.4 17.6V21" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function ChecksIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}

function ConflictIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.05.05a2 2 0 1 1-2.83 2.83l-.05-.05A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6V20a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.05.05a2 2 0 1 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1H4a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.05-.05a2 2 0 1 1 2.83-2.83l.05.05A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6V4a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.05-.05a2 2 0 1 1 2.83 2.83l-.05.05A1.7 1.7 0 0 0 19.4 9c.24.35.44.68.6 1H20a2 2 0 1 1 0 4h-.08c-.16.32-.36.65-.52 1Z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg {...svgProps(14)}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12 4 4 10-10" />
    </svg>
  );
}

function SquaresIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
