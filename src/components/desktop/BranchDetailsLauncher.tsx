'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SmoothCorners } from '@lisse/react';
import { CollapsedRailIcon, ChevronsLeftIcon, ChevronsRightIcon } from './branch-rail-collapse';
import { WorkspaceContextSection } from './WorkspaceContextSection';
import {
  COLLAPSED_BRANCH_RAIL_CAPSULE_RADIUS,
  COLLAPSED_BRANCH_RAIL_CAPSULE_WIDTH,
  COLLAPSED_BRANCH_RAIL_INSET,
  COLLAPSED_BRANCH_RAIL_WIDTH,
  WORKSPACE_RAIL_CORNER_SMOOTHING,
} from './branch-rail-geometry';
import {
  BranchDetailsOverlay,
  GhIcon,
  GlobeIcon,
  SquaresIcon,
  type OverlayPanelTab,
  type ProgressRowData,
  type PrChecksSummary,
} from './BranchDetailsOverlay';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { useWorkspaceChanges } from './o8-panel/workspace-rail/ChangesList';
import { useThreadSources } from './use-thread-sources';
import { useO8BrowserTabs } from './use-o8-browser-tabs';
import { FooterPorts } from './desktop-status-bar/footer-ports';
import { Mail, MailOpen, PageEdit } from 'iconoir-react';
import { openSupervisorInboxTab, useSupervisorInboxCount } from './desktop-status-bar/supervisor-inbox-store';
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
  if (runtime === 'opencode') return 'OpenCode 2';
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
  const hasData = Boolean(data);
  const [progressOpen, setProgressOpen] = useState(false);

  // Click-to-open overlay (Q ruling 2026-07-14). The capsule stays in layout
  // (never pushes the chat); CLICKING it toggles the full card stack open as a
  // portal overlay that FLOATS over the chat. `collapsed === false` = open.
  // NOT hover-triggered — the operator wants the same click trigger as before,
  // with the drawer floating over the chat instead of widening the rail.
  const capsuleRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const measure = useCallback(() => {
    const el = capsuleRef.current;
    if (el) setAnchorRect(el.getBoundingClientRect());
  }, []);

  const isOpen = visible && !collapsed;
  const toggle = () => {
    onToggleCollapsed?.();
    window.requestAnimationFrame(() => {
      if (isOpen) capsuleRef.current?.querySelector<HTMLButtonElement>('[aria-expanded]')?.focus();
      else overlayRef.current?.querySelector<HTMLButtonElement>('[aria-label="Hide workspace details"]')?.focus();
    });
  };

  // Measure the capsule on mount + keep the overlay glued to it. The overlay is
  // always mounted (it cross-fades / morphs on open+close), so we measure
  // regardless of open state.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    measure();
    // The right panel animates the workspace width without a window resize.
    // Keep the closed drawer's anchor current too, so its first open frame
    // starts at the rail instead of jumping from the previous panel position.
    const workspace = capsuleRef.current?.closest('[data-mcp-scope="workspace"]');
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (workspace) observer?.observe(workspace);
    const onScrollResize = () => measure();
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
    };
  }, [measure, visible, hasData]);

  // Panel-divider drags move the capsule WITHOUT firing window scroll/resize —
  // the drag writes widths straight onto the column DOM styles — so the card
  // floated at a stale anchor the instant the right panel moved (Q report
  // 0.1.604). No layout event covers that (the capsule's own wrapper is fixed
  // width), so while the card is OPEN, re-glue on a rAF loop (floating-ui
  // autoUpdate pattern) — state only updates when the rect actually moved, so
  // idle frames are a string compare. Closed card costs nothing.
  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    measure();
    let raf = 0;
    let lastKey = '';
    const glue = () => {
      const el = capsuleRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const key = `${rect.top}|${rect.right}`;
        if (key !== lastKey) {
          lastKey = key;
          setAnchorRect(rect);
        }
      }
      raf = window.requestAnimationFrame(glue);
    };
    raf = window.requestAnimationFrame(glue);
    return () => window.cancelAnimationFrame(raf);
  }, [isOpen, measure]);

  const activePacket = useMemo(
    () => repoPath ? pickActivePacketForRepo(data?.missionState?.packets, data?.selectedPacketId, repoPath) : null,
    [data?.missionState?.packets, data?.selectedPacketId, repoPath],
  );

  const activeTarget = useMemo(
    () => repoPath ? pickTarget(activePacket, data?.workspaceTargets ?? [], repoPath) : null,
    [activePacket, data?.workspaceTargets, repoPath],
  );

  // Git identity is the chat's checkout, never a selected worker's branch.
  const resolvedRepoPath = repoPath;
  const changes = useWorkspaceChanges(resolvedRepoPath, { active: visible });
  const branch = changes.branch && changes.branch !== 'unknown' && changes.branch !== '(detached)' ? changes.branch : null;
  // Sources card: the links the operator put into THIS conversation.
  const sources = useThreadSources(threadId);
  // Browser card: the pages o8 owns in the right panel's pane, o8 itself filtered out.
  const browserTabs = useO8BrowserTabs();
  // Supervisor inbox: same count + states the bottom status bar's badge shows.
  const inboxCount = useSupervisorInboxCount();
  // PR for the current branch, surfaced inline so the operator sees status
  // without opening the PRs tab (Q ruling 2026-07-11). Keyed by repo NAME (the
  // list API resolves slug/name, not a local path). Null on main/master or
  // when no open PR points at the branch.
  const prRepoIdent = (changes.repoSlug || activeTarget?.repoName)
    ?? (resolvedRepoPath ? resolvedRepoPath.split('/').filter(Boolean).pop() ?? null : null);
  const branchPr = useBranchPr(visible ? prRepoIdent : null, visible ? branch : null, resolvedRepoPath);
  const { detail: prDetail } = usePrDetail(branchPr?.number ?? null, branchPr?.repoSlug ?? null);

  // Coexists with the wide O8 panel now (Q ruling 2026-07-11) — no longer
  // self-hides when it's open; the caller's railFits gating handles space.
  if (!data || !visible) return null;

  const prChecks: PrChecksSummary = summarizePrChecks(prDetail?.statusCheckRollup ?? []);
  const prCommentCount = prDetail
    ? prDetail.issueComments.length + prDetail.reviewComments.length
    : 0;

  const packetRuntime = activePacket?.runtime ?? data.agents.find((agent) => agent.status === 'running' || agent.currentTask)?.runtime;
  const progressRows = buildProgressRows(activePacket);
  const inboxActive = inboxCount > 0;
  const inboxTitle = inboxActive
    ? `${inboxCount} human-required inbox item${inboxCount === 1 ? '' : 's'}`
    : 'Supervisor inbox';

  const open = (tab: OverlayPanelTab) => {
    data.onOpenO8Panel?.({ repoPath: resolvedRepoPath, tab });
  };

  const togglePip = (surface: 'browser' | 'spec') => {
    data.onToggleWorkspacePip?.(surface, resolvedRepoPath);
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

  const utilities = <div aria-label="Workspace tools" style={{ display: 'flex', justifyContent: 'space-between', gap: 4, paddingTop: 8, flexShrink: 0 }}>
    <WorkspaceUtility label="Inbox" title={inboxTitle} onClick={openSupervisorInboxTab} warning={inboxActive}>
      <MailOpen width={14} height={14} strokeWidth={1.6} />{inboxActive ? <span>{inboxCount}</span> : null}
    </WorkspaceUtility>
    <WorkspaceUtility label="o8.md" title="o8.md preview" onClick={() => togglePip('spec')}><PageEdit width={14} height={14} strokeWidth={1.6} /></WorkspaceUtility>
    {isOpen ? <FooterPorts placement="rail" onPortPreview={(_port, url) => openSource(url)} onTriggerClick={NOOP}
      renderTrigger={({ pageCount }) => <WorkspaceUtility label="Ports" title={`Ports and browser preview${pageCount ? ` · ${pageCount} local pages` : ''}`}
        onClick={() => togglePip('browser')}><GlobeIcon /></WorkspaceUtility>} /> : null}
  </div>;

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
          inert={isOpen}
          aria-hidden={isOpen}
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
          {/* The arrow opens the drawer. Every other glyph here used to ALSO
              just open the drawer — five buttons for one action. They carry
              their own destinations now (Q 2026-07-16). */}
          <CollapsedRailIcon title="Workspace details" expanded={isOpen} onClick={toggle}><ChevronsLeftIcon /></CollapsedRailIcon>
          <CollapsedRailIcon
            title={inboxTitle}
            onClick={openSupervisorInboxTab}
            tone={inboxActive ? 'warning' : 'default'}
          >
            {inboxActive
              ? <Mail width={14} height={14} color="currentColor" strokeWidth={2} />
              : <MailOpen width={14} height={14} color="currentColor" strokeWidth={2} />}
          </CollapsedRailIcon>
          <CollapsedRailIcon title="o8.md preview" onClick={() => togglePip('spec')}><PageEdit width={14} height={14} color="currentColor" strokeWidth={2} /></CollapsedRailIcon>
          {prDetail ? (
            <CollapsedRailIcon title={`Pull request #${prDetail.number}`} onClick={() => open('prs')}><GhIcon /></CollapsedRailIcon>
          ) : null}
          {/* The globe carries the dev-server hover that used to sit in the
              status bar (Q 2026-07-16). Hover lists the local pages; clicking
              the globe opens the browser; clicking a page in the list opens
              THAT url in it. */}
          {!isOpen ? <FooterPorts
            placement="rail"
            // Clicking a page in the hover opens that url in o8's browser —
            // the same path the Sources rows already take.
            onPortPreview={(_port, url) => openSource(url)}
            onTriggerClick={() => togglePip('browser')}
            renderTrigger={({ pageCount }) => (
              <CollapsedRailIcon
                title={pageCount > 0 ? `Browser preview · ${pageCount} local page${pageCount === 1 ? '' : 's'}` : 'Browser preview'}
                onClick={NOOP}
              >
                <GlobeIcon />
              </CollapsedRailIcon>
            )}
          /> : null}
          {sources.length > 0 ? <CollapsedRailIcon title="Sources" onClick={toggle}><SquaresIcon /></CollapsedRailIcon> : null}
        </SmoothCorners>
      </aside>

      {anchorRect ? (
        <BranchDetailsOverlay
          overlayRef={overlayRef}
          open={isOpen}
          anchorRect={anchorRect}
          onMouseEnter={NOOP}
          onMouseLeave={NOOP}
          onToggleCollapsed={toggle}
          workspaceContext={<WorkspaceContextSection key={resolvedRepoPath ?? 'home'} repoPath={resolvedRepoPath}
            repoName={changes.repoSlug || activeTarget?.repoName} changes={changes}
            onBrowseFiles={path => data.onOpenO8Panel?.({ repoPath: path, tab: 'files' })}
            onReviewChanges={() => open('workspace')}
            controls={<CollapsedRailIcon title="Hide workspace details" onClick={toggle}><ChevronsRightIcon /></CollapsedRailIcon>} />}
          utilities={utilities}
          progressHint={activePacket?.referenceLabel ?? activeTarget?.label ?? 'Workspace'}
          progressRows={progressRows}
          progressOpen={progressOpen}
          onToggleProgress={() => setProgressOpen((value) => !value)}
          prDetail={prDetail ?? null}
          prChecks={prChecks}
          prCommentCount={prCommentCount}
          browserTabs={browserTabs}
          onOpenBrowserTab={openSource}
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
): ProgressRowData[] {
  if (!activePacket) return [];

  return [
    { label: activePacket.title || activePacket.referenceLabel, done: true, muted: false },
    { label: activePacket.status.replace(/_/g, ' '), done: activePacket.status !== 'blocked' && activePacket.status !== 'failed', muted: false },
    ...(activePacket.lastEventLabel ? [{ label: activePacket.lastEventLabel, done: true, muted: false }] : []),
  ];
}

function WorkspaceUtility({ label, title, onClick, warning, children }: {
  label: string; title: string; onClick: () => void; warning?: boolean; children: ReactNode;
}) {
  return <button type="button" title={title} aria-label={title} onClick={onClick}
    onMouseEnter={event => { event.currentTarget.style.background = 'var(--t-hover)'; }}
    onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }}
    onFocus={event => { event.currentTarget.style.background = 'var(--t-hover)'; }}
    onBlur={event => { event.currentTarget.style.background = 'transparent'; }}
    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, minHeight: 32, borderWidth: 0, borderRadius: 8,
      paddingTop: 5, paddingRight: 8, paddingBottom: 5, paddingLeft: 8, background: 'transparent', fontFamily: 'inherit', fontSize: 11,
      fontWeight: 300, color: warning ? 'var(--t-warning)' : 'var(--t-text-secondary)', cursor: 'pointer' }}>
    {children}{label}
  </button>;
}

function summarizePrChecks(rollup: PrCheck[]): { label: string; danger: boolean } | null {
  if (!rollup || rollup.length === 0) return null;
  const failing = rollup.filter((c) => ['failure', 'error', 'cancelled', 'timed_out', 'action_required'].includes((c.conclusion ?? '').toLowerCase())).length;
  if (failing > 0) return { label: `${failing} check${failing === 1 ? '' : 's'} failing`, danger: true };
  const pending = rollup.some((c) => ['in_progress', 'queued', 'pending', 'waiting', 'requested'].includes((c.status ?? '').toLowerCase()));
  if (pending) return { label: 'Checks running', danger: false };
  return { label: 'All checks passed', danger: false };
}
