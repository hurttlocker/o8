'use client';

/**
 * WorkspaceHeaderStrip — header strip for the center workspace column.
 * Hosts workspace chrome like the terminal toggle. When the left column is
 * collapsed this strip becomes the leftmost one, so it can also carry the
 * macOS traffic-light inset + the sidebar toggle. Part of epic #1089.
 *
 * Each control renders only when its handler prop is provided — that lets
 * the dashboard gate compact mode / sidebar-collapsed state from the call site.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { SidebarTogglePill } from './SidebarTogglePill';
import { HeaderIconPill } from './HeaderIconPill';
import { TabCleanupButton } from './TabCleanupButton';
import { HeaderScrollArrow } from './HeaderScrollArrow';
import { HeaderPlayButton } from './HeaderPlayButton';
import { ApprovalInboxBadge } from '../title-bar/ApprovalInboxBadge';
import { IconColumns, IconTerminal } from '../title-bar/icons';
import { RightPanelMorphButton } from '../title-bar/RightPanelMorphButton';

interface WorkspaceHeaderStripProps {
  /** Render the 78px macOS traffic-light spacer — set when this strip is leftmost. */
  leadingInset?: boolean;
  /** Sidebar toggle — shown only when a handler is provided (left column collapsed). */
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  /** When the sidebar is collapsed, hovering the toggle pill drops the
   *  hover-preview overlay (Claude pattern). These handlers wire that
   *  trigger to the same callbacks the overlay itself uses, so moving
   *  between pill and overlay doesn't dismiss. 2026-05-27. */
  onSidebarHoverEnter?: () => void;
  onSidebarHoverLeave?: () => void;
  /** Terminal toggle — shown only when a handler is provided. */
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
  /** Split the active workspace tile into a second pane. */
  onSplitWorkspacePanel?: () => void;
  /**
   * O8 panel re-open toggle. Rendered as the rightmost icon ONLY when the
   * panel is collapsed — when it's open, the toggle in PanelHeaderStrip is
   * already visible, so we don't duplicate. Operator regression catch
   * post-#1089: when the panel column disappears, its toggle goes with it,
   * leaving no re-open affordance.
   */
  rightPanelOpen?: boolean;
  onToggleRightPanel?: () => void;
  /** Pending approvals badge shown only when the right panel header is absent. */
  approvalCount?: number;
  onOpenInbox?: () => void;
  /** Active workspace tab title rendered in the center slot. Codex / Claude
   *  put the conversation name in the title bar itself instead of a
   *  separate strip below. Supports "repo / chat" split styling. Used
   *  when there's exactly one open tab. */
  headerLabel?: string | null;
  /** Full visible-tab list for the single workspace. When length > 1
   *  the center slot morphs from "title" to a horizontal pill strip
   *  (Codex pattern). When length <= 1 we fall back to headerLabel. */
  headerTabs?: Array<{
    id: string;
    label: string;
    kind: string;
    runtime: string | null;
    packetStatus: string | null;
  }>;
  /** Stable workspace id for routing header pill events back to the owning tile. */
  workspaceId?: string | null;
  /** Active tab id from the headerTabs list — drives which pill renders
   *  as filled. */
  headerActiveTabId?: string | null;
  /** Number of non-active finished CLI-session tabs eligible for explicit cleanup. */
  finishedTabCount?: number;
  /** Header-owned toggle for the Codex-style project context rail.
   *  Hidden unless the active workspace tab can render that rail. */
  projectContextRailAvailable?: boolean;
  projectContextRailVisible?: boolean;
  onToggleProjectContextRail?: () => void;
  /** Side-by-side pill strips for splits — when populated (2+ entries)
   *  the center slot renders two pill rows separated by a small vertical
   *  divider, one per split workspace. Replaces headerLabel + headerTabs
   *  in this mode. */
  splitHeaderWorkspaces?: Array<{
    workspaceId: string;
    tabs: Array<{ id: string; label: string; kind: string; runtime: string | null; packetStatus: string | null }>;
    activeTabId: string | null;
    finishedTabCount?: number;
    contextRailAvailable?: boolean;
    contextRailVisible?: boolean;
  }> | null;
}

export function WorkspaceHeaderStrip({
  leadingInset = false,
  sidebarVisible = true,
  onToggleSidebar,
  onSidebarHoverEnter,
  onSidebarHoverLeave,
  bottomPanelVisible = true,
  onToggleBottomPanel,
  onSplitWorkspacePanel,
  rightPanelOpen = false,
  onToggleRightPanel,
  approvalCount = 0,
  onOpenInbox,
  headerLabel,
  headerTabs,
  workspaceId,
  headerActiveTabId,
  finishedTabCount = 0,
  projectContextRailAvailable = false,
  projectContextRailVisible = true,
  onToggleProjectContextRail,
  splitHeaderWorkspaces,
}: WorkspaceHeaderStripProps) {
  const showRightPanelFallbackToggle = !rightPanelOpen && Boolean(onToggleRightPanel);
  const showApprovalBadge = approvalCount > 0 && Boolean(onOpenInbox);
  const showProjectContextToggle = projectContextRailAvailable && Boolean(onToggleProjectContextRail);
  const tabs = headerTabs ?? [];
  const isSplit = Boolean(splitHeaderWorkspaces && splitHeaderWorkspaces.length >= 2);
  // Split mode → side-by-side pill strips. Single 2+ tabs → pill strip.
  // Single 1 or 0 tabs → title + `…` menu.
  const usePillStrip = !isSplit && tabs.length > 1;
  return (
    <ColumnHeaderStrip
      drag
      left={
        <>
          {/* When this strip is leftmost (sidebar collapsed), pad past the
              macOS traffic lights — they're drawn at fixed window coords by
              the OS. 64px clears the green light (~x=62) plus the standard
              ~10px breathing room before the toggle pill. */}
          {leadingInset ? <div style={{ width: 64, flexShrink: 0 }} /> : null}
          {onToggleSidebar ? (
            <SidebarTogglePill
              sidebarVisible={sidebarVisible}
              onClick={onToggleSidebar}
              onHoverEnter={onSidebarHoverEnter}
              onHoverLeave={onSidebarHoverLeave}
              // Workspace strip is 36 tall starting at y=4; the left card's
              // strip is 32 starting at y=5. +1 offset (vs the left default)
              // keeps the pill at the same window-y across the sidebar
              // toggle — without this it shifts 1px on collapse.
              yNudge={-3}
            />
          ) : null}
        </>
      }
      center={isSplit && splitHeaderWorkspaces ? (
        <SplitHeaderPillStrips workspaces={splitHeaderWorkspaces} />
      ) : usePillStrip ? (
        <HeaderPillStrip
          tabs={tabs}
          activeTabId={headerActiveTabId ?? null}
          workspaceId={workspaceId}
          finishedTabCount={finishedTabCount}
        />
      ) : headerLabel ? (
        // Just the name — Cursor-style. Rename / archive / delete live on the
        // left session list's right-click menu (operator 2026-07-14), so the
        // header needs no `…` actions button.
        <div data-no-drag style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <HeaderLabelText label={headerLabel} />
        </div>
      ) : null}
      right={
        showApprovalBadge || showProjectContextToggle || onToggleBottomPanel || onSplitWorkspacePanel || showRightPanelFallbackToggle ? (
          <>
            {showApprovalBadge && onOpenInbox ? (
              <ApprovalInboxBadge count={approvalCount} onClick={onOpenInbox} />
            ) : null}
            {onToggleBottomPanel ? (
              <HeaderIconPill
                icon={<IconTerminal />}
                label="Toggle terminal"
                onClick={onToggleBottomPanel}
                yNudge={-3}
              />
            ) : null}
            {onSplitWorkspacePanel ? (
              <HeaderIconPill
                icon={<IconColumns />}
                label="Split workspace"
                onClick={onSplitWorkspacePanel}
                yNudge={-3}
              />
            ) : null}
            {showRightPanelFallbackToggle ? (
              <RightPanelMorphButton
                workspacePanelVisible={false}
                o8PanelVisible={false}
                onToggleO8Panel={onToggleRightPanel}
              />
            ) : null}
          </>
        ) : null
      }
    />
  );
}

/** Split-mode header — two HeaderPillStrips side by side, with a small
 *  vertical divider between them mirroring the visual split below.
 *  Each strip dispatches with its own workspaceId so the right
 *  WorkspaceTerminalRoot claims the click. Per-pane ▶ play sits at the
 *  right edge of each section; × close-pane shows on non-first panes
 *  only (closing the first/primary doesn't make sense). */
function SplitHeaderPillStrips({
  workspaces,
}: {
  workspaces: Array<{
    workspaceId: string;
    tabs: Array<{ id: string; label: string; kind: string; runtime: string | null; packetStatus: string | null }>;
    activeTabId: string | null;
    finishedTabCount?: number;
    contextRailAvailable?: boolean;
    contextRailVisible?: boolean;
  }>;
}) {
  const dispatchSpawn = useCallback((workspaceId: string, kind: 'orchestrator' | 'chat' | 'terminal') => {
    window.dispatchEvent(new CustomEvent('o8:request-spawn-tab', { detail: { kind, workspaceId } }));
  }, []);
  const dispatchClose = useCallback((workspaceId: string) => {
    window.dispatchEvent(new CustomEvent('o8:request-close-workspace', { detail: { workspaceId } }));
  }, []);
  const dispatchToggleProjectContextRail = useCallback((workspaceId: string) => {
    window.dispatchEvent(new CustomEvent('o8:request-toggle-context-rail', { detail: { workspaceId } }));
  }, []);
  // Human-readable pane name for aria-labels so split-mode controls
  // don't collide ("New tab (left pane)" vs "New tab (right pane)").
  const paneLabel = (index: number) => (
    workspaces.length === 2
      ? (index === 0 ? 'left pane' : 'right pane')
      : `pane ${index + 1}`
  );

  return (
    // No blanket data-no-drag here (Q ruling 2026-07-12): every pill guards
    // itself, so the strip's NEGATIVE SPACE stays a window-drag region even
    // when tabs are present over the workspace.
    <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch' }}>
      {workspaces.map((workspace, index) => {
        const canClose = index !== 0;
        return (
          <div
            key={workspace.workspaceId}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              borderLeftWidth: index === 0 ? 0 : 1,
              borderLeftStyle: 'solid',
              borderLeftColor: 'var(--t-divider)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
              <HeaderPillStrip
                tabs={workspace.tabs}
                activeTabId={workspace.activeTabId}
                workspaceId={workspace.workspaceId}
                finishedTabCount={workspace.finishedTabCount ?? 0}
              />
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, paddingLeft: 4, paddingRight: 6, flexShrink: 0 }}>
              {workspace.contextRailAvailable ? (
                <HeaderIconPill
                  icon={<IconInfoCircle />}
                  label={workspace.contextRailVisible === false ? `Show project context (${paneLabel(index)})` : `Hide project context (${paneLabel(index)})`}
                  title={workspace.contextRailVisible === false ? 'Show project context' : 'Hide project context'}
                  onClick={() => dispatchToggleProjectContextRail(workspace.workspaceId)}
                  yNudge={-3}
                />
              ) : null}
              <HeaderPlayButton
                onSpawnOrchestrator={() => dispatchSpawn(workspace.workspaceId, 'orchestrator')}
                onSpawnChat={() => dispatchSpawn(workspace.workspaceId, 'chat')}
                onSpawnTerminal={() => dispatchSpawn(workspace.workspaceId, 'terminal')}
                ariaSuffix={paneLabel(index)}
              />
              {canClose ? (
                <SplitPaneCloseButton onClick={() => dispatchClose(workspace.workspaceId)} paneLabel={paneLabel(index)} />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SplitPaneCloseButton({ onClick, paneLabel }: { onClick: () => void; paneLabel?: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={paneLabel ? `Close split (${paneLabel})` : 'Close split'}
      title="Close split"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: hovered ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}

function IconInfoCircle({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10v6" />
      <path d="M12 7.5h.01" />
    </svg>
  );
}

/** Codex-style pill strip — renders in the WorkspaceHeaderStrip's
 *  center slot when 2+ tabs are open. Active pill is a filled dark
 *  rounded rect; inactive pills are icon + label only. Horizontal
 *  scroll when overflowing. Click → dispatches a window event the
 *  workspace listens for. */
function HeaderPillStrip({
  tabs,
  activeTabId,
  workspaceId,
  finishedTabCount = 0,
}: {
  tabs: Array<{
    id: string;
    label: string;
    kind: string;
    runtime: string | null;
    packetStatus: string | null;
  }>;
  activeTabId: string | null;
  /** When set, pill events include this id so the matching
   *  WorkspaceTerminalRoot can claim them. Lets two strips coexist
   *  in split mode without selecting on the wrong pane. */
  workspaceId?: string | null;
  finishedTabCount?: number;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Truncate to one word when the strip is crowded — Codex feel: at 5+
  // tabs each pill compacts to just its first significant word. Sibling
  // packets often share a verb ("Add …" × 3), so when the one-word form
  // collides we extend those pills to two words — three identical "Add"
  // pills carry zero information.
  const crowded = tabs.length >= 5;
  const crowdedLabels = useMemo(() => {
    const firsts = tabs.map((tab) => significantWords(tab.label, 1));
    const counts = new Map<string, number>();
    for (const word of firsts) counts.set(word, (counts.get(word) ?? 0) + 1);
    const out = new Map<string, string>();
    tabs.forEach((tab, index) => {
      const first = firsts[index];
      out.set(tab.id, (counts.get(first) ?? 0) > 1 ? significantWords(tab.label, 2) : first);
    });
    return out;
  }, [tabs]);

  // Overflow affordances. The strip hides its scrollbar (scrollbarWidth:none)
  // to stay chrome-clean, so when many tabs are open the off-screen ones are
  // invisible *and* unreachable with a normal mouse — only a horizontal
  // trackpad swipe scrolls them. Two fixes: map vertical wheel → horizontal
  // scroll (non-passive native listener so preventDefault sticks), and fade
  // the overflowing edge(s) via a mask so you can SEE there's more. 2026-05-30.
  const [edges, setEdges] = useState({ left: false, right: false });

  const recomputeEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setEdges({
      left: el.scrollLeft > 1,
      right: el.scrollLeft < maxScroll - 1,
    });
  }, []);

  const handleSelect = useCallback((tabId: string) => {
    window.dispatchEvent(new CustomEvent('o8:request-select-tab', { detail: { tabId, workspaceId: workspaceId ?? null } }));
  }, [workspaceId]);
  const handleClose = useCallback((tabId: string) => {
    window.dispatchEvent(new CustomEvent('o8:request-close-tab', { detail: { tabId, workspaceId: workspaceId ?? null } }));
  }, [workspaceId]);
  const handleCleanup = useCallback(() => {
    window.dispatchEvent(new CustomEvent('o8:request-cleanup-tabs', { detail: { workspaceId: workspaceId ?? null } }));
  }, [workspaceId]);

  // Click-to-scroll for mouse users. The wheel-map + edge fade aren't a
  // discoverable, clickable affordance with a regular mouse — the edge arrows
  // (rendered when there's overflow that way) call this. One ~70%-viewport
  // nudge per click, smooth. 2026-05-30.
  const scrollByStep = useCallback((dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(140, el.clientWidth * 0.7), behavior: 'smooth' });
  }, []);

  // Native non-passive wheel listener: React's onWheel attaches passive in
  // some builds, which silently no-ops preventDefault. Attach our own so the
  // vertical wheel reliably becomes horizontal scroll without scrolling the
  // page. Only consume the event when there's actually overflow to move.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return; // nothing to scroll
      const dominant = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (dominant === 0) return;
      e.preventDefault();
      el.scrollLeft += dominant * (e.deltaMode === 1 ? 16 : 1);
      recomputeEdges();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('scroll', recomputeEdges, { passive: true });
    const ro = new ResizeObserver(recomputeEdges);
    ro.observe(el);
    recomputeEdges();
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', recomputeEdges);
      ro.disconnect();
    };
  }, [recomputeEdges]);

  // Recompute when the tab set changes (pills added/removed shift overflow).
  useEffect(() => { recomputeEdges(); }, [tabs.length, recomputeEdges]);

  // Selecting a tab that's scrolled off-screen should bring it into view —
  // otherwise clicking a pill in the (separate) AgentPanel can activate a tab
  // you can't see in the strip.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector('[data-pill-active="true"]');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
    }
    const id = window.setTimeout(recomputeEdges, 220);
    return () => window.clearTimeout(id);
  }, [activeTabId, tabs.length, recomputeEdges]);

  // Fade only the edge(s) that have more content behind them. Transparent-safe
  // (masks the pills themselves) so it works over the vibrancy chrome where a
  // solid gradient overlay would read as a grey smear.
  const FADE = 18;
  const cleanupButtonVisible = finishedTabCount >= 1;
  const cleanupButtonSpace = cleanupButtonVisible ? 54 : 0;
  const maskImage = edges.left && edges.right
    ? `linear-gradient(to right, transparent 0, #000 ${FADE}px, #000 calc(100% - ${FADE}px), transparent 100%)`
    : edges.left
      ? `linear-gradient(to right, transparent 0, #000 ${FADE}px, #000 100%)`
      : edges.right
        ? `linear-gradient(to right, #000 0, #000 calc(100% - ${FADE}px), transparent 100%)`
        : 'none';

  return (
    <div
      style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}
    >
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'none',
          paddingLeft: 6,
          paddingRight: 6,
          maskImage,
          WebkitMaskImage: maskImage,
        } as React.CSSProperties}
      >
      {/* Continuity V1 — wrap each pill in a layout-aware motion.div so
          mounts scale + fade in, exits scale + fade out, and the surviving
          pills reflow smoothly. `mode="popLayout"` takes the exiting pill
          out of the flex flow during its exit so the remaining pills slide
          into place without leaving a gap. The full row→pill morph (V2)
          will reuse this wrapper as the target host. */}
      <AnimatePresence initial={false} mode="popLayout">
        {tabs.map((tab) => (
          <motion.div
            key={tab.id}
            layout
            data-pill-active={tab.id === activeTabId ? 'true' : undefined}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            style={{ display: 'inline-flex', flexShrink: 0 }}
          >
            <HeaderPill
              tab={tab}
              active={tab.id === activeTabId}
              crowded={crowded}
              crowdedLabel={crowdedLabels.get(tab.id) ?? null}
              onSelect={handleSelect}
              onClose={handleClose}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      </div>
      {cleanupButtonVisible ? (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            paddingLeft: 4,
            paddingRight: 6,
            flexShrink: 0,
          }}
        >
          <TabCleanupButton finishedTabCount={finishedTabCount} onCleanup={handleCleanup} />
        </div>
      ) : null}
      {/* Mouse-friendly scroll affordance — clickable chevrons appear at an
          overflowing edge so a regular mouse (no trackpad swipe) can still
          reach off-screen tabs. Siblings of the scroll container (not children)
          so they stay pinned while the pills scroll under them. 2026-05-30. */}
      {edges.left ? <HeaderScrollArrow side="left" onClick={() => scrollByStep(-1)} /> : null}
      {edges.right ? <HeaderScrollArrow side="right" onClick={() => scrollByStep(1)} rightOffset={cleanupButtonSpace + 1} /> : null}
    </div>
  );
}

function HeaderPill({
  tab,
  active,
  crowded,
  crowdedLabel,
  onSelect,
  onClose,
}: {
  tab: {
    id: string;
    label: string;
    kind: string;
    runtime: string | null;
    packetStatus: string | null;
  };
  active: boolean;
  crowded: boolean;
  crowdedLabel: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const display = crowded ? (crowdedLabel ?? significantWords(tab.label, 1)) : tab.label;
  return (
    <div
      data-no-drag
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(event) => {
        // Right-click → context menu hook. Real menu lands in a later
        // phase; for now we just suppress the native menu so the host
        // is ready for the wired version.
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('o8:request-pill-menu', {
          detail: { tabId: tab.id, x: event.clientX, y: event.clientY },
        }));
      }}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 7,
        background: active
          ? 'var(--t-input-bg)'
          : hovered
            ? 'var(--t-hover)'
            : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        fontFamily: 'var(--font-sans-system)',
        fontSize: 12,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        lineHeight: 1.25,
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onClick={() => onSelect(tab.id)}
    >
      {/* Leading slot morphs runtime-icon ↔ close-X on hover — fixed
          14px so the pill width never shifts. Click while hovered
          (showing X) closes; the rest of the pill selects. */}
      <button
        type="button"
        onClick={(event) => {
          if (!hovered) return; // only the X is the close target
          event.stopPropagation();
          onClose(tab.id);
        }}
        aria-label={hovered ? `Close ${tab.label || 'tab'}` : undefined}
        title={hovered ? 'Close tab (⌘W)' : undefined}
        tabIndex={hovered ? 0 : -1}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          borderWidth: 0,
          background: 'transparent',
          color: hovered ? 'var(--t-text)' : 'inherit',
          cursor: hovered ? 'pointer' : 'inherit',
          padding: 0,
          flexShrink: 0,
        }}
      >
        {hovered ? (
          <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <PillRuntimeGlyph kind={tab.kind} runtime={tab.runtime} />
        )}
      </button>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: crowded ? 80 : 140,
        }}
      >
        {display}
      </span>
    </div>
  );
}

function PillRuntimeGlyph({ kind }: { kind: string; runtime: string | null }) {
  // Single-color minimal glyph so the pill stays Codex-flat. The full
  // brand-colored runtime icons (CodexIcon / ClaudeIcon / GeminiIcon /
  // OpenCodeIcon) sit too heavily in a crowded strip. If we want to
  // reintroduce them, the swap point is here.
  const color = 'currentColor';
  if (kind === 'terminal') {
    return (
      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m4 17 6-6-6-6" />
        <line x1="12" x2="20" y1="19" y2="19" />
      </svg>
    );
  }
  if (kind === 'canvas') {
    return (
      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M3 9h18" />
      </svg>
    );
  }
  if (kind === 'orchestrator') {
    return (
      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="6" r="2" />
        <circle cx="6" cy="18" r="2" />
        <circle cx="18" cy="18" r="2" />
        <path d="M12 8v4M12 12l-6 4M12 12l6 4" />
      </svg>
    );
  }
  if (kind === 'fleet-canvas') {
    return (
      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="7" height="7" x="3" y="3" rx="1.5" />
        <rect width="7" height="7" x="14" y="6" rx="1.5" />
        <rect width="7" height="7" x="6" y="14" rx="1.5" />
      </svg>
    );
  }
  // llm-chat or single-runtime chat
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function significantWords(label: string, count: number): string {
  if (!label) return '';
  // Split on " / " first (repo / title pattern) — keep the title side.
  const slash = label.indexOf(' / ');
  const tail = slash >= 0 ? label.slice(slash + 3) : label;
  const words = tail.trim().split(/\s+/);
  return words.slice(0, count).join(' ');
}

// Codex-style "<repo> / <chat title>" split: repo gets emphasis, the
// separator is faint, the title is muted. Matches HeaderLabelText in
// TabBar.tsx — kept duplicated rather than shared since this strip
// renders at the column-shell layer (no workspace-terminal import).
function HeaderLabelText({ label }: { label: string }) {
  const separator = ' / ';
  const separatorIndex = label.indexOf(separator);
  if (separatorIndex < 0) {
    return (
      <span
        title={label}
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--t-text)',
          fontWeight: 500,
          fontSize: 12,
          letterSpacing: 0,
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        {label}
      </span>
    );
  }
  const repo = label.slice(0, separatorIndex);
  const title = label.slice(separatorIndex + separator.length);
  return (
    <span
      title={label}
      style={{
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 12,
        fontFamily: 'var(--font-sans-system)',
        letterSpacing: 0,
      }}
    >
      <span style={{ color: 'var(--t-text)', fontWeight: 500 }}>{repo}</span>
      <span style={{ color: 'var(--t-text-faint)', fontWeight: 400 }}> / </span>
      <span style={{ color: 'var(--t-text-secondary)', fontWeight: 400 }}>{title}</span>
    </span>
  );
}
