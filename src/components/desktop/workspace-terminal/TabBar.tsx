'use client';

import { memo, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { RegisteredRepo, TerminalTab } from '@/components/desktop/workspace-terminal/types';
import {
  PhosphorCaretLeft,
  PhosphorCaretRight,
  PhosphorXBold,
  PhosphorXCircle,
} from '@/components/desktop/workspace-terminal/icons';
import { WorkspaceLaunchPicker } from '@/components/desktop/workspace-terminal/WorkspaceLaunchPicker';
import { describeWorkspaceChatTab, workspaceTabPrimaryLabel } from '@/components/desktop/workspace-terminal/utils';
import { repoColor } from '@/lib/repos/repo-color';
import { CodexIcon, ClaudeIcon, GeminiIcon, OpenCodeIcon } from '@/components/desktop/repo-registry/shared';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { compactPacketLabel } from '@/lib/workspace-terminal/compact-packet-label';
import { packetStateColorScheme, type PacketStateKey } from '@/lib/packet-state-colors';
import type { OrchestratorPacketStatus } from '@/lib/orchestrator/types';

// State-coloring for dispatched packet tabs. Now sources colors from
// the shared packetStateColorScheme so tab + left-rail surfaces stay
// in sync — extending from the old 2-state (latest/merged) treatment
// to all 5 states (running / review / merged / failed / neutral).
function tabStateKey(status: OrchestratorPacketStatus | null | undefined, isLatestDispatch: boolean): PacketStateKey {
  if (!status) return isLatestDispatch ? 'review' : 'neutral';
  if (status === 'released') return 'merged';
  if (status === 'failed' || status === 'blocked') return 'failed';
  if (status === 'awaiting_review' || isLatestDispatch) return 'review';
  if (status === 'running' || status === 'launching') return 'running';
  return 'neutral';
}
const TAB_BAR_HEIGHT = 38;
const TAB_GAP = 4;
// Flat tabs: no paper-card chrome, active = subtle pill,
// inactive = transparent text + icon only. Tighter density so the
// bar fits inline without competing with the workspace below.
const FLAT_TAB_HEIGHT = 26;
const FLAT_TAB_RADIUS = 7;

function formatDispatchedAt(epochMs: number): string {
  try {
    const date = new Date(epochMs);
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `Dispatched ${time}`;
  } catch {
    return 'Dispatched';
  }
}

// Render the in-header chat title. If the label is "<repo> / <title>"
// (common pattern from workspaceConversationHeaderLabel) the repo gets
// emphasized and the title softens — same treatment Codex uses for
// its breadcrumb-style header.
function HeaderLabelText({ label }: { label: string }) {
  const separator = ' / ';
  const separatorIndex = label.indexOf(separator);
  if (separatorIndex < 0) {
    return <span style={{ color: 'var(--t-text)', fontWeight: 500 }}>{label}</span>;
  }
  const repo = label.slice(0, separatorIndex);
  const title = label.slice(separatorIndex + separator.length);
  return (
    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--t-text)', fontWeight: 500 }}>{repo}</span>
      <span style={{ color: 'var(--t-text-faint)', fontWeight: 400 }}> / </span>
      <span style={{ color: 'var(--t-text-secondary)', fontWeight: 400 }}>{title}</span>
    </span>
  );
}

interface TabBarProps {
  tabs: TerminalTab[];
  activeTabId: string;
  launchRequestKey?: number;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: (agentId: string, repo?: RegisteredRepo) => void;
  onNewLLMChatTab: (repo?: RegisteredRepo) => void;
  scopedRepo?: RegisteredRepo | null;
  canCloseTile?: boolean;
  onCloseTile?: () => void;
  onReorderTabs?: (draggedTabId: string, dropTargetTabId: string) => void;
  /** When false, the tab list scroll area is hidden but the workspace
   *  header strip still renders the launch picker + close-tile control.
   *  This is how the wide-viewport path keeps per-workspace play / close-split
   *  buttons even when the tab list itself is collapsed away. */
  showTabList?: boolean;
  /** Conversation/session label rendered inline in the header strip when
   *  the tab list is collapsed. Mirrors how Codex / Claude desktop apps
   *  put the chat title IN the header instead of below it. */
  headerLabel?: string | null;
}

export const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  launchRequestKey,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onNewLLMChatTab,
  scopedRepo,
  canCloseTile,
  onCloseTile,
  onReorderTabs,
  showTabList = true,
  headerLabel = null,
}: TabBarProps) {
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const draggedTabIdRef = useRef<string | null>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [flashTabId, setFlashTabId] = useState<string | null>(null);

  // Hotkey-driven tab focus flash: page.tsx dispatches `o8:tab-focus-flash`
  // with the target tabId; we pulse an accent shadow + ring for ~180ms so
  // the user gets a confirmation that the keybind landed.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (!detail?.tabId) return;
      setFlashTabId(detail.tabId);
      const timer = window.setTimeout(() => setFlashTabId(null), 220);
      return () => window.clearTimeout(timer);
    };
    window.addEventListener('o8:tab-focus-flash', handler as EventListener);
    return () => window.removeEventListener('o8:tab-focus-flash', handler as EventListener);
  }, []);
  const orchestratorData = useOrchestratorData();
  const latestDispatchedTabId = orchestratorData?.latestDispatchedTabId ?? null;
  const latestDispatchedAt = orchestratorData?.latestDispatchedAt ?? null;

  const syncTabScroll = useCallback(() => {
    const element = tabScrollRef.current;
    if (!element) return;
    setCanScrollLeft(element.scrollLeft > 2);
    setCanScrollRight(element.scrollLeft + element.clientWidth < element.scrollWidth - 2);
  }, []);

  const scrollTabs = useCallback((dir: 'left' | 'right') => {
    tabScrollRef.current?.scrollBy({ left: dir === 'left' ? -180 : 180, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(syncTabScroll);
    return () => cancelAnimationFrame(frame);
  }, [syncTabScroll, tabs.length]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        // Compact strip. Active tabs overlap the bottom divider by 1px so
        // the selected tab and workspace body meet on the same edge.
        height: TAB_BAR_HEIGHT,
        minHeight: TAB_BAR_HEIGHT,
        // Theme-tinted glass over the macOS vibrancy. --t-panel resolves
        // to translucent white in light mode and translucent dark in
        // midnight, so the strip reads as light-on-light or dark-on-dark
        // glass instead of raw HudWindow vibrancy bleeding through (which
        // looked correct in midnight but went silver-grey in light mode).
        background: 'var(--t-panel)',
        // Drop the explicit divider — the workspace card's top edge is now
        // the only horizontal line, and the active tab punches through it.
        borderBottomWidth: 0,
        flexShrink: 0,
        overflow: 'visible',
        zIndex: 10,
        position: 'relative',
      }}
    >
      <div style={{ position: 'relative', display: 'flex', flex: 1, overflow: 'visible' }}>
        {!showTabList ? (
          // Chat / conversation title sits IN the header strip (Codex /
          // Claude pattern), filling the dead space between the left edge
          // and the play + close-tile controls on the right. When no label
          // is available the flex spacer keeps the controls right-aligned.
          <div
            title={headerLabel ?? undefined}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              paddingLeft: 14,
              paddingRight: 10,
              color: 'var(--t-text-secondary)',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 12,
              lineHeight: '16px',
              fontWeight: 400,
              letterSpacing: 0,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {headerLabel ? <HeaderLabelText label={headerLabel} /> : null}
          </div>
        ) : null}
        {showTabList && canScrollLeft ? (
          <div
            role="button"
            tabIndex={0}
            aria-label="Scroll tabs left"
            onClick={() => scrollTabs('left')}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); scrollTabs('left'); } }}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 44,
              minWidth: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 3,
              cursor: 'pointer',
              background: 'linear-gradient(to right, var(--t-panel, rgba(0,0,0,0.18)) 30%, transparent)',
              color: 'var(--t-text-secondary)',
            }}
          >
            <PhosphorCaretLeft size={12} />
          </div>
        ) : null}
        {showTabList && canScrollRight ? (
          <div
            role="button"
            tabIndex={0}
            aria-label="Scroll tabs right"
            onClick={() => scrollTabs('right')}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); scrollTabs('right'); } }}
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              width: 44,
              minWidth: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 3,
              cursor: 'pointer',
              background: 'linear-gradient(to left, var(--t-chat-surface-bg, #ffffff) 60%, transparent)',
              color: 'var(--t-text-secondary)',
            }}
          >
            <PhosphorCaretRight size={12} />
          </div>
        ) : null}

        <div
          ref={tabScrollRef}
          onScroll={syncTabScroll}
          onMouseEnter={syncTabScroll}
          style={{
            display: showTabList ? 'flex' : 'none',
            flex: 1,
            gap: TAB_GAP,
            height: TAB_BAR_HEIGHT + 1,
            marginBottom: -1,
            // Dock tabs to the workspace edge. Active tabs use the same
            // surface as the strip, so the rounded left edge feels flush
            // instead of exposing a cutout.
            paddingLeft: 0,
            paddingRight: 12,
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'none',
          }}
        >
          {tabs.map((tab) => {
            // An orchestrator tab is "permanent" (no close X) only when
            // it's the ONLY fleet-mode orchestrator tab — closing the
            // last one would leave the workspace without a default
            // orchestrator surface. Once the operator spawns a second
            // via + New session, BOTH become closable so they can clean
            // up duplicates. Single-mode orchestrators (Claude/Codex/
            // Gemini chooser tabs) are always closable regardless.
            const orchestratorTabCount = tabs.reduce((count, t) => count + (t.kind === 'orchestrator' && t.mode !== 'single' ? 1 : 0), 0);
            const isActive = tab.id === activeTabId;
            const isOrchestrator = tab.kind === 'orchestrator';
            const isSingleRuntimeTab = isOrchestrator && tab.mode === 'single';
            const isPermanentOrchestrator = isOrchestrator && tab.mode !== 'single' && orchestratorTabCount <= 1;
            const rawLabel = workspaceTabPrimaryLabel(tab);
            const chatTabMeta = describeWorkspaceChatTab(tab);
            const packetTitle = tab.orchestrationPacket?.title ?? null;
            const compactLabel = packetTitle ? compactPacketLabel(packetTitle) : '';
            const primaryLabel = compactLabel
              ? compactLabel
              : ((isOrchestrator
                  || rawLabel === 'Assistant'
                  || rawLabel === 'Agent'
                  || rawLabel === 'Chat'
                ) && chatTabMeta?.summary
                ? chatTabMeta.summary
                : rawLabel);
            const tabDetail = tab.orchestrationPacket
              ? (chatTabMeta?.detail ?? tab.orchestrationPacket.branchTarget ?? null)
              : (chatTabMeta?.summary ?? chatTabMeta?.detail ?? null);
            // Match by tab.id OR chatSessionKey — MCP-dispatched packets
            // store the lane's sessionKey as latestDispatchedTabId because
            // the auto-generated tab id isn't reachable from the dispatch
            // path. Both forms of the ref should light the same tab.
            const isLatestDispatch = !!tab.orchestrationPacket
              && latestDispatchedTabId !== null
              && (latestDispatchedTabId === tab.id || latestDispatchedTabId === tab.chatSessionKey);
            const dispatchTooltip = isLatestDispatch && latestDispatchedAt
              ? formatDispatchedAt(latestDispatchedAt)
              : null;
            const fullPacketTitle = packetTitle ?? null;
            const tabTitle = [fullPacketTitle, dispatchTooltip, tabDetail, chatTabMeta?.fullSummary]
              .filter((value): value is string => Boolean(value))
              .join(' · ')
              || primaryLabel
              || tab.label;

            const isFlashing = flashTabId === tab.id;
            // Project-identity dot: only when this tab has a repo AND another
            // open tab lives in a DIFFERENT repo — i.e. only when there's real
            // multi-repo ambiguity to resolve. Single-repo workspaces stay clean.
            const tabRepoPath = tab.repo?.localPath ?? null;
            const showRepoDot = Boolean(tabRepoPath)
              && tabs.some((t) => t.id !== tab.id && t.repo?.localPath && t.repo.localPath !== tabRepoPath);
            const stateKey = tabStateKey(tab.orchestrationPacket?.status, isLatestDispatch);
            const stateScheme = packetStateColorScheme(stateKey);
            const hasStateColor = stateKey !== 'neutral';
            // Codex-flat surfaces: active tab gets a subtle pill bg, inactive
            // stays transparent except for the optional state tint that lets
            // a glance pick out review-orange / merged-green / failed-red.
            const activeNeutralBg = 'var(--t-input-bg)';
            const tabBackground = isActive
              ? (hasStateColor ? stateScheme.tabBg : activeNeutralBg)
              : (hasStateColor ? stateScheme.tabBg : 'transparent');
            const tabBoxShadow = isFlashing
              ? '0 0 0 2px var(--t-accent-soft, rgba(37, 99, 235, 0.22)), 0 6px 18px rgba(37, 99, 235, 0.28)'
              : 'none';
            const tabTextColor = hasStateColor
              ? stateScheme.tabText
              : (isActive ? 'var(--t-text)' : 'var(--t-text-muted)');
            // Border lives only on tabs with state OR on the active tab —
            // inactive neutral tabs are pure text. Separator between
            // adjacent tabs comes from the wrapping strip, not each row.
            const tabBorderColor = isActive && hasStateColor
              ? stateScheme.tabBorder
              : 'transparent';
            return (
              <button
                type="button"
                key={tab.id}
                draggable={!isOrchestrator && !!onReorderTabs}
                onDragStart={(e) => {
                  draggedTabIdRef.current = tab.id;
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', tab.id);
                }}
                onDragOver={(e) => {
                  if (!draggedTabIdRef.current || draggedTabIdRef.current === tab.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDragOverTabId(tab.id);
                }}
                onDragLeave={() => { if (dragOverTabId === tab.id) setDragOverTabId(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverTabId(null);
                  const fromId = draggedTabIdRef.current;
                  draggedTabIdRef.current = null;
                  if (fromId && fromId !== tab.id) onReorderTabs?.(fromId, tab.id);
                }}
                onDragEnd={() => { draggedTabIdRef.current = null; setDragOverTabId(null); }}
                onClick={() => onSelectTab(tab.id)}
                title={tabTitle}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  boxSizing: 'border-box',
                  height: FLAT_TAB_HEIGHT,
                  minHeight: FLAT_TAB_HEIGHT,
                  paddingTop: 0,
                  paddingBottom: 0,
                  paddingLeft: 9,
                  paddingRight: 9,
                  marginTop: 0,
                  marginBottom: 0,
                  marginLeft: 0,
                  marginRight: 0,
                  borderWidth: hasStateColor && isActive ? 1 : 0,
                  borderStyle: 'solid',
                  borderColor: tabBorderColor,
                  borderRadius: FLAT_TAB_RADIUS,
                  background: tabBackground,
                  boxShadow: tabBoxShadow,
                  color: tabTextColor,
                  fontSize: 12,
                  fontWeight: 300,
                  fontFamily: 'var(--font-sans-system)',
                  letterSpacing: '-0.1px',
                  lineHeight: 1.25,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                  position: 'relative',
                  zIndex: isActive ? 2 : 1,
                }}
                onMouseEnter={(event) => {
                  if (isActive || hasStateColor) return;
                  event.currentTarget.style.background = 'var(--t-hover)';
                }}
                onMouseLeave={(event) => {
                  if (isActive || hasStateColor) return;
                  event.currentTarget.style.background = 'transparent';
                }}
              >
                {showRepoDot && tabRepoPath ? (
                  <span
                    title={tab.repo?.name ?? tabRepoPath}
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: repoColor(tabRepoPath),
                      flexShrink: 0,
                      opacity: isActive ? 1 : 0.7,
                    }}
                  />
                ) : null}
                {tab.unseen ? (
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#2563eb', flexShrink: 0 }} />
                ) : null}
                {isSingleRuntimeTab && tab.singleRuntime === 'codex' ? (
                  <CodexIcon size={13} />
                ) : isSingleRuntimeTab && tab.singleRuntime === 'gemini' ? (
                  <GeminiIcon size={13} />
                ) : isSingleRuntimeTab && tab.singleRuntime === 'opencode' ? (
                  <OpenCodeIcon size={13} />
                ) : tab.kind === 'orchestrator' || tab.chatRuntime === 'claude-code' ? (
                  <ClaudeIcon size={13} />
                ) : tab.chatRuntime === 'codex' ? (
                  <CodexIcon size={13} />
                ) : tab.chatRuntime === 'gemini' ? (
                  <GeminiIcon size={13} />
                ) : tab.chatRuntime === 'opencode' ? (
                  <OpenCodeIcon size={13} />
                ) : null}
                <span
                  style={{
                    maxWidth: 160,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {primaryLabel}
                </span>
                {tabs.length > 1 && !isPermanentOrchestrator ? (
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Close ${primaryLabel} tab`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.stopPropagation();
                        onCloseTab(tab.id);
                      }
                    }}
                    style={{
                      // Apple HIG hit-zone: visible glyph stays small (14x14) but
                      // the click region expands to 44x44 via the transparent
                      // overlay child below. Position relative so the absolute
                      // overlay anchors to this element.
                      position: 'relative',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 14,
                      height: 14,
                      borderRadius: 4,
                      borderWidth: 0,
                      marginLeft: 2,
                      color: 'var(--t-text-secondary)',
                      cursor: 'pointer',
                      transition: 'background 100ms, color 100ms',
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)';
                      event.currentTarget.style.color = '#ef4444';
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background = 'transparent';
                      event.currentTarget.style.color = '#475569';
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        width: 44,
                        height: 44,
                        transform: 'translate(-50%, -50%)',
                        background: 'transparent',
                      }}
                    />
                    <PhosphorXBold size={9} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <WorkspaceLaunchPicker
        launchRequestKey={launchRequestKey}
        scopedRepo={scopedRepo}
        onNewTab={onNewTab}
        onNewLLMChatTab={onNewLLMChatTab}
      />

      {canCloseTile && onCloseTile ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            paddingRight: 8,
            paddingLeft: 2,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onCloseTile}
            aria-label="Close tile"
            style={chromeButtonStyle}
            onMouseEnter={closeHoverOn}
            onMouseLeave={closeHoverOff}
          >
            <span aria-hidden="true" style={chromeButtonHitZoneStyle} />
            <PhosphorXCircle size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
});

// Visible chrome button stays at 24x24 so the split/close glyphs read as
// compact chrome rather than primary actions; the transparent overlay below
// expands the click region to the HIG 44x44 minimum.
const chromeButtonStyle = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  alignSelf: 'center',
  width: 24,
  height: 24,
  borderRadius: 6,
  borderWidth: 0,
  background: 'transparent',
  color: 'var(--t-text-muted)',
  cursor: 'pointer',
  transition: 'background 100ms, color 100ms',
} as const;

const chromeButtonHitZoneStyle = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: 44,
  height: 44,
  transform: 'translate(-50%, -50%)',
  background: 'transparent',
} as const;

function closeHoverOn(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)';
  event.currentTarget.style.color = '#ef4444';
}

function closeHoverOff(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
  event.currentTarget.style.color = 'var(--t-text-faint)';
}
