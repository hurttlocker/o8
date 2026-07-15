'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SmoothCorners } from '@lisse/react';
import { CollapsedRailIcon, ChevronsLeftIcon } from './branch-rail-collapse';
import {
  COLLAPSED_BRANCH_RAIL_CAPSULE_RADIUS,
  COLLAPSED_BRANCH_RAIL_CAPSULE_WIDTH,
  COLLAPSED_BRANCH_RAIL_INSET,
  COLLAPSED_BRANCH_RAIL_WIDTH,
  WORKSPACE_RAIL_CORNER_SMOOTHING,
} from './branch-rail-geometry';
import {
  BranchDetailsOverlay,
  ChecksIcon,
  DiffIcon,
  GhIcon,
  GlobeIcon,
  SquaresIcon,
  WorkerIcon,
  type OverlayPanelTab,
  type ProgressRowData,
  type PrChecksSummary,
} from './BranchDetailsOverlay';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { useWorkspaceChanges } from './o8-panel/workspace-rail/ChangesList';
import { useThreadSources } from './use-thread-sources';
import { useBranchPr } from './useBranchPr';
import { usePrDetail } from './pr-panel/usePrDetail';
import type { PrCheck } from './pr-panel/types';
import type { OrchestratorPacket, OrchestratorRuntime, OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';

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

const NOOP = () => {};

export function BranchDetailsLauncher({ visible = true, repoPath = null, threadId = null, collapsed = false, onToggleCollapsed }: {
  visible?: boolean;
  repoPath?: string | null;
  /** Active orchestrator thread — scopes the Sources card to this conversation. */
  threadId?: string | null;
  /** Open state (inverted): `false` = the drawer overlay is open; `true` = closed to the capsule. Toggled by click. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const data = useOrchestratorData();
  const [progressOpen, setProgressOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(true);

  // Click-to-open overlay (Q ruling 2026-07-14). The capsule stays in layout
  // (never pushes the chat); CLICKING it toggles the full card stack open as a
  // portal overlay that FLOATS over the chat. `collapsed === false` = open.
  // NOT hover-triggered — the operator wants the same click trigger as before,
  // with the drawer floating over the chat instead of widening the rail.
  const capsuleRef = useRef<HTMLElement | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const measure = useCallback(() => {
    const el = capsuleRef.current;
    if (el) setAnchorRect(el.getBoundingClientRect());
  }, []);

  const isOpen = !collapsed;

  // Measure the capsule on mount + keep the overlay glued to it. The overlay is
  // always mounted (it cross-fades / morphs on open+close), so we measure
  // regardless of open state.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    measure();
    const onScrollResize = () => measure();
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
    return () => {
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
    };
  }, [measure]);

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
  // Sources card: the links the operator put into THIS conversation.
  const sources = useThreadSources(threadId);
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

  const prChecks: PrChecksSummary = summarizePrChecks(prDetail?.statusCheckRollup ?? []);
  const prCommentCount = prDetail
    ? prDetail.issueComments.length + prDetail.reviewComments.length
    : 0;

  const packetRuntime = activePacket?.runtime ?? data.agents.find((agent) => agent.status === 'running' || agent.currentTask)?.runtime;
  const subagentLabel = activePacket
    ? runtimeLabel(activePacket.runtime)
    : data.agents.find((agent) => agent.currentTask || agent.status === 'running')?.name;
  const progressRows = buildProgressRows(activePacket, activeTarget, branch);
  const hasDiff = changes.totalAdditions > 0 || changes.totalDeletions > 0;

  const open = (tab: OverlayPanelTab) => {
    data.onOpenO8Panel?.({ repoPath: resolvedRepoPath, tab });
  };

  // Open a source link in the right-side browser panel. Reveal the Browser tab
  // first, then push the URL once the pane has mounted (the o8:open-browser
  // listener switches to the tab + navigates — see O8Panel / O8BrowserPane).
  const openSource = (href: string) => {
    data.onOpenO8Panel?.({ repoPath: resolvedRepoPath, tab: 'browser' });
    if (typeof window === 'undefined') return;
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('o8:open-browser', { detail: { url: href } }));
    }, 250);
  };

  return (
    <>
      {/* Always-in-layout trigger: the collapsed icon capsule (Codex parity, Q
          2026-07-13). Clicking an icon floats the full card stack as an overlay
          — the capsule width never changes, so the chat is never pushed. */}
      <aside
        ref={capsuleRef}
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
            // Morph: the capsule fades out as the card scales up out of its
            // corner, so the two never coexist (Q ruling 2026-07-14).
            opacity: isOpen ? 0 : 1,
            pointerEvents: isOpen ? 'none' : 'auto',
            transition: 'opacity 140ms cubic-bezier(0.22, 1, 0.36, 1)',
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

      {anchorRect ? (
        <BranchDetailsOverlay
          open={isOpen}
          anchorRect={anchorRect}
          onMouseEnter={NOOP}
          onMouseLeave={NOOP}
          onToggleCollapsed={onToggleCollapsed}
          progressHint={activePacket?.referenceLabel ?? activeTarget?.label ?? 'Workspace'}
          progressRows={progressRows}
          progressOpen={progressOpen}
          onToggleProgress={() => setProgressOpen((value) => !value)}
          environmentOpen={environmentOpen}
          onToggleEnvironment={() => setEnvironmentOpen((value) => !value)}
          hasDiff={hasDiff}
          additions={changes.totalAdditions}
          deletions={changes.totalDeletions}
          changesFileCount={changes.files.length}
          branch={branch}
          prDetail={prDetail ?? null}
          prChecks={prChecks}
          prCommentCount={prCommentCount}
          subagentLabel={subagentLabel}
          subagentDanger={activePacket?.status === 'blocked' || activePacket?.status === 'failed'}
          onSelectSubagent={() => {
            if (activePacket?.lane?.sessionKey) data.onSelectSession?.(activePacket.lane.sessionKey);
          }}
          browserHost={typeof window === 'undefined' ? undefined : window.location.host}
          sources={sources}
          onOpenSource={openSource}
          runtimeLabelText={runtimeLabel(packetRuntime)}
          onOpenTab={open}
        />
      ) : null}
    </>
  );
}

function buildProgressRows(
  activePacket: OrchestratorPacket | null,
  activeTarget: OrchestratorWorkspaceTarget | null,
  branch: string,
): ProgressRowData[] {
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
