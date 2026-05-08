'use client';

import { memo, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { RegisteredRepo, TerminalTab } from '@/components/desktop/workspace-terminal/types';
import {
  PhosphorCaretLeft,
  PhosphorCaretRight,
  PhosphorSplitVertical,
  PhosphorXBold,
  PhosphorXCircle,
} from '@/components/desktop/workspace-terminal/icons';
import { WorkspaceLaunchPicker } from '@/components/desktop/workspace-terminal/WorkspaceLaunchPicker';
import { describeWorkspaceChatTab, workspaceTabPrimaryLabel } from '@/components/desktop/workspace-terminal/utils';
import { CodexIcon, ClaudeIcon, GeminiIcon, OpenCodeIcon } from '@/components/desktop/repo-registry/shared';
import { chromeNeoSurface, chromeNeoHoverSurface } from '@/components/desktop/chrome/ChromeButton';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { compactPacketLabel } from '@/lib/workspace-terminal/compact-packet-label';

const LATEST_DISPATCH_BG = 'rgba(255, 90, 31, 0.08)';
const LATEST_DISPATCH_BORDER = 'rgba(255, 90, 31, 0.22)';
const LATEST_DISPATCH_TEXT = '#FF5A1F';

// Terminal-state coloring for dispatched packets that have shipped. The
// orange "latest dispatch" pill yields to green on `released` so a quick
// glance at the tab strip reads as "this work is in / this work is done"
// without having to expand the packet.
const MERGED_DISPATCH_BG = 'rgba(22, 163, 74, 0.08)';
const MERGED_DISPATCH_BORDER = 'rgba(22, 163, 74, 0.28)';
const MERGED_DISPATCH_TEXT = '#15803d';
const TAB_BAR_HEIGHT = 38;
const TAB_GAP = 4;
const TAB_TOP_RADIUS = 15;
const PRIMARY_TAB_MIN_WIDTH = 214;

function formatDispatchedAt(epochMs: number): string {
  try {
    const date = new Date(epochMs);
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `Dispatched ${time}`;
  } catch {
    return 'Dispatched';
  }
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
  onSplitVertical?: () => void;
  onSplitHorizontal?: () => void;
  canCloseTile?: boolean;
  onCloseTile?: () => void;
  onReorderTabs?: (draggedTabId: string, dropTargetTabId: string) => void;
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
  onSplitVertical,
  onSplitHorizontal,
  canCloseTile,
  onCloseTile,
  onReorderTabs,
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
        {canScrollLeft ? (
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
        {canScrollRight ? (
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
            display: 'flex',
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
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId;
            const isFirstTab = index === 0;
            const isOrchestrator = tab.kind === 'orchestrator';
            const isSingleRuntimeTab = isOrchestrator && tab.mode === 'single';
            const isPermanentOrchestrator = isOrchestrator && tab.mode !== 'single';
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
            // Terminal "this work shipped" signal — wins over orange so a
            // merged packet's tab reads green even if it's still the most
            // recent dispatch by time.
            const isMergedDispatch = tab.orchestrationPacket?.status === 'released';
            const dispatchTooltip = isLatestDispatch && latestDispatchedAt
              ? formatDispatchedAt(latestDispatchedAt)
              : null;
            const fullPacketTitle = packetTitle ?? null;
            const tabTitle = [fullPacketTitle, dispatchTooltip, tabDetail, chatTabMeta?.fullSummary]
              .filter((value): value is string => Boolean(value))
              .join(' · ')
              || primaryLabel
              || tab.label;

            const neoSurface = chromeNeoSurface(isActive);
            const isFlashing = flashTabId === tab.id;
            const isPlainActive = isActive && !isLatestDispatch && !isMergedDispatch;
            const baseBoxShadow = isMergedDispatch
              ? `inset 0 0 0 1px ${MERGED_DISPATCH_BORDER}`
              : isLatestDispatch
                ? `inset 0 0 0 1px ${LATEST_DISPATCH_BORDER}`
                : (isPlainActive
                  ? 'inset 0 1px 0 rgba(255, 255, 255, 0.18)'
                  : neoSurface.boxShadow);
            const tabBackground = isMergedDispatch
              ? MERGED_DISPATCH_BG
              : isLatestDispatch
                ? LATEST_DISPATCH_BG
                : (isActive
                  ? 'var(--t-panel)'
                  : neoSurface.background);
            const tabBoxShadow = isFlashing
              ? `${baseBoxShadow}, 0 0 0 2px var(--t-accent-soft, rgba(37, 99, 235, 0.22)), 0 6px 18px rgba(37, 99, 235, 0.28)`
              : baseBoxShadow;
            const tabTextColor = isMergedDispatch
              ? MERGED_DISPATCH_TEXT
              : isLatestDispatch
                ? LATEST_DISPATCH_TEXT
                : (isActive ? 'var(--t-text)' : 'var(--t-text-secondary)');
            const tabBorderColor = isMergedDispatch
              ? MERGED_DISPATCH_BORDER
              : isLatestDispatch
                ? LATEST_DISPATCH_BORDER
                : 'var(--t-divider-subtle)';
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
                  height: isActive ? TAB_BAR_HEIGHT + 1 : TAB_BAR_HEIGHT,
                  minHeight: isActive ? TAB_BAR_HEIGHT + 1 : TAB_BAR_HEIGHT,
                  minWidth: isFirstTab ? PRIMARY_TAB_MIN_WIDTH : undefined,
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: isFirstTab ? 22 : 10,
                  paddingRight: 8,
                  marginTop: 0,
                  marginBottom: isActive ? -1 : 0,
                  marginLeft: 0,
                  marginRight: 0,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: tabBorderColor,
                  borderBottomWidth: isActive ? 0 : 1,
                  // Top corners keep the Apple-style squircle while the fill
                  // matches the header surface, avoiding a visible edge bite.
                  borderTopLeftRadius: TAB_TOP_RADIUS,
                  borderTopRightRadius: TAB_TOP_RADIUS,
                  borderBottomLeftRadius: 0,
                  borderBottomRightRadius: 0,
                  borderLeftWidth: dragOverTabId === tab.id ? 2 : 1,
                  borderLeftStyle: 'solid',
                  borderLeftColor: dragOverTabId === tab.id ? '#2563eb' : tabBorderColor,
                  background: tabBackground,
                  boxShadow: tabBoxShadow,
                  color: tabTextColor,
                  fontSize: 11,
                  fontWeight: isActive ? 560 : 500,
                  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                  letterSpacing: '-0.01em',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 150ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                  position: 'relative',
                  zIndex: isActive ? 2 : 1,
                }}
                onMouseEnter={(event) => {
                  if (isActive || isLatestDispatch || isMergedDispatch) return;
                  const hover = chromeNeoHoverSurface();
                  event.currentTarget.style.background = hover.background;
                  event.currentTarget.style.boxShadow = hover.boxShadow;
                }}
                onMouseLeave={(event) => {
                  if (isActive || isLatestDispatch || isMergedDispatch) return;
                  event.currentTarget.style.background = neoSurface.background;
                  event.currentTarget.style.boxShadow = neoSurface.boxShadow;
                }}
              >
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

      {onSplitVertical || onSplitHorizontal || (canCloseTile && onCloseTile) ? (
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
          {onSplitVertical ? (
            <button
              type="button"
              onClick={onSplitVertical}
              aria-label="Split vertically"
              style={chromeButtonStyle}
              onMouseEnter={hoverChromeOn}
              onMouseLeave={hoverChromeOff}
            >
              <span aria-hidden="true" style={chromeButtonHitZoneStyle} />
              <PhosphorSplitVertical size={14} />
            </button>
          ) : null}
          {canCloseTile && onCloseTile ? (
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
          ) : null}
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

function hoverChromeOn(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'var(--t-hover)';
  event.currentTarget.style.color = 'var(--t-text)';
}

function hoverChromeOff(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
  event.currentTarget.style.color = 'var(--t-text-muted)';
}

function closeHoverOn(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)';
  event.currentTarget.style.color = '#ef4444';
}

function closeHoverOff(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
  event.currentTarget.style.color = 'var(--t-text-faint)';
}
