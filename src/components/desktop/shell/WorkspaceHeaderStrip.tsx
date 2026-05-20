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

import { useCallback, useEffect, useRef, useState } from 'react';
import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { TitleBarButton } from '../title-bar/TitleBarButton';
import { IconColumns, IconPanelLeft, IconTerminal } from '../title-bar/icons';
import { RightPanelMorphButton } from '../title-bar/RightPanelMorphButton';

interface WorkspaceHeaderStripProps {
  /** Render the 78px macOS traffic-light spacer — set when this strip is leftmost. */
  leadingInset?: boolean;
  /** Sidebar toggle — shown only when a handler is provided (left column collapsed). */
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
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
  /** Active tab id from the headerTabs list — drives which pill renders
   *  as filled. */
  headerActiveTabId?: string | null;
  /** Optional action callbacks for the `…` menu next to the title.
   *  Items only render when the corresponding callback is provided —
   *  the menu hides entirely when none are set. */
  onTitleRename?: () => void;
  onTitleArchive?: () => void;
  onTitleShare?: () => void;
  /** Single-workspace spawn shortcut — when in single mode the global
   *  header carries the ▶ play button (the per-pane lower TabBar that
   *  used to host it is hidden). Each spawn callback gates its menu
   *  item. May come off — operator wants to feel it out first. */
  onSpawnOrchestrator?: () => void;
  onSpawnChat?: () => void;
  onSpawnTerminal?: () => void;
}

export function WorkspaceHeaderStrip({
  leadingInset = false,
  sidebarVisible = true,
  onToggleSidebar,
  bottomPanelVisible = true,
  onToggleBottomPanel,
  onSplitWorkspacePanel,
  rightPanelOpen = false,
  onToggleRightPanel,
  headerLabel,
  onTitleRename,
  onTitleArchive,
  onTitleShare,
  onSpawnOrchestrator,
  onSpawnChat,
  onSpawnTerminal,
  headerTabs,
  headerActiveTabId,
}: WorkspaceHeaderStripProps) {
  const showRightPanelFallbackToggle = !rightPanelOpen && Boolean(onToggleRightPanel);
  const tabs = headerTabs ?? [];
  // 2+ tabs → pill strip, no title (each pill carries its own label).
  // 1 or 0 → render the title + `…` menu as before.
  const usePillStrip = tabs.length > 1;
  const hasTitleMenu = !usePillStrip && headerLabel && (onTitleRename || onTitleArchive || onTitleShare);
  const hasPlayButton = Boolean(onSpawnOrchestrator || onSpawnChat || onSpawnTerminal);
  return (
    <ColumnHeaderStrip
      drag
      left={
        <>
          {leadingInset ? <div style={{ width: 78, flexShrink: 0 }} /> : null}
          {onToggleSidebar ? (
            <TitleBarButton
              icon={<IconPanelLeft />}
              label="Toggle sidebar"
              onClick={onToggleSidebar}
              active={sidebarVisible}
            />
          ) : null}
        </>
      }
      center={usePillStrip ? (
        <HeaderPillStrip tabs={tabs} activeTabId={headerActiveTabId ?? null} />
      ) : headerLabel ? (
        <div data-no-drag style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <HeaderLabelText label={headerLabel} />
          {hasTitleMenu ? (
            <TitleMenuButton
              onRename={onTitleRename}
              onArchive={onTitleArchive}
              onShare={onTitleShare}
            />
          ) : null}
        </div>
      ) : null}
      right={
        hasPlayButton || onToggleBottomPanel || onSplitWorkspacePanel || showRightPanelFallbackToggle ? (
          <>
            {hasPlayButton ? (
              <HeaderPlayButton
                onSpawnOrchestrator={onSpawnOrchestrator}
                onSpawnChat={onSpawnChat}
                onSpawnTerminal={onSpawnTerminal}
              />
            ) : null}
            {onToggleBottomPanel ? (
              <TitleBarButton
                icon={<IconTerminal />}
                label="Toggle terminal"
                onClick={onToggleBottomPanel}
                active={bottomPanelVisible}
              />
            ) : null}
            {onSplitWorkspacePanel ? (
              <TitleBarButton
                icon={<IconColumns />}
                label="Split workspace"
                onClick={onSplitWorkspacePanel}
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

/** Codex-style pill strip — renders in the WorkspaceHeaderStrip's
 *  center slot when 2+ tabs are open. Active pill is a filled dark
 *  rounded rect; inactive pills are icon + label only. Horizontal
 *  scroll when overflowing. Click → dispatches a window event the
 *  workspace listens for. */
function HeaderPillStrip({
  tabs,
  activeTabId,
}: {
  tabs: Array<{
    id: string;
    label: string;
    kind: string;
    runtime: string | null;
    packetStatus: string | null;
  }>;
  activeTabId: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Truncate to one word when the strip is crowded — Codex feel: at 5+
  // tabs each pill compacts to just its first significant word.
  const crowded = tabs.length >= 5;

  const handleSelect = useCallback((tabId: string) => {
    window.dispatchEvent(new CustomEvent('o8:request-select-tab', { detail: { tabId } }));
  }, []);
  const handleClose = useCallback((tabId: string) => {
    window.dispatchEvent(new CustomEvent('o8:request-close-tab', { detail: { tabId } }));
  }, []);

  return (
    <div
      ref={scrollRef}
      data-no-drag
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
      }}
    >
      {tabs.map((tab) => (
        <HeaderPill
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          crowded={crowded}
          onSelect={handleSelect}
          onClose={handleClose}
        />
      ))}
    </div>
  );
}

function HeaderPill({
  tab,
  active,
  crowded,
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
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const display = crowded ? firstSignificantWord(tab.label) : tab.label;
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
        paddingRight: hovered && !active ? 6 : 10,
        borderRadius: 7,
        background: active
          ? 'var(--t-input-bg)'
          : hovered
            ? 'var(--t-hover)'
            : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        fontFamily: 'var(--font-sans-system)',
        fontSize: 11.5,
        fontWeight: active ? 560 : 500,
        letterSpacing: '-0.005em',
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onClick={() => onSelect(tab.id)}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>
        <PillRuntimeGlyph kind={tab.kind} runtime={tab.runtime} />
      </span>
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
      {hovered ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose(tab.id);
          }}
          aria-label="Close tab"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            borderRadius: 4,
            borderWidth: 0,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = 'var(--t-input-bg)';
            event.currentTarget.style.color = 'var(--t-text)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'transparent';
            event.currentTarget.style.color = 'var(--t-text-muted)';
          }}
        >
          <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

function PillRuntimeGlyph({ kind, runtime }: { kind: string; runtime: string | null }) {
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
  // llm-chat or single-runtime chat
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function firstSignificantWord(label: string): string {
  if (!label) return '';
  // Split on " / " first (repo / title pattern) — keep the title side.
  const slash = label.indexOf(' / ');
  const tail = slash >= 0 ? label.slice(slash + 3) : label;
  const words = tail.trim().split(/\s+/);
  return words[0] ?? '';
}

/** Header ▶ play button — mirrors the WorkspaceLaunchPicker dropdown
 *  but lives in the global column header instead of the lower per-pane
 *  TabBar. Used only in single-workspace mode; when the operator splits,
 *  each pane's own lower TabBar carries the spawn button instead. */
function HeaderPlayButton({
  onSpawnOrchestrator,
  onSpawnChat,
  onSpawnTerminal,
}: {
  onSpawnOrchestrator?: () => void;
  onSpawnChat?: () => void;
  onSpawnTerminal?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = useCallback((handler?: () => void) => () => {
    setOpen(false);
    handler?.();
  }, []);

  return (
    <div ref={wrapperRef} data-no-drag style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label="New tab"
        title="New tab"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 6,
          borderWidth: 0,
          background: open || hovered ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-accent)',
          cursor: 'pointer',
          padding: 0,
          transition: 'background 120ms ease',
        }}
      >
        <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 220,
            borderRadius: 10,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            background: 'var(--t-panel)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
            paddingTop: 4,
            paddingBottom: 4,
            zIndex: 100,
            overflow: 'hidden',
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {onSpawnOrchestrator ? (
            <TitleMenuItem label="Orchestrator" onClick={pick(onSpawnOrchestrator)} />
          ) : null}
          {onSpawnChat ? (
            <TitleMenuItem label="Chat" onClick={pick(onSpawnChat)} />
          ) : null}
          {onSpawnTerminal ? (
            <TitleMenuItem label="Terminal" onClick={pick(onSpawnTerminal)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** `…` overflow menu next to the workspace title. Codex puts a small
 *  action chevron right of the conversation name for Rename / Archive /
 *  Share. We render the matching three items, each gated on its handler
 *  prop so the dashboard can wire them piecemeal. */
function TitleMenuButton({
  onRename,
  onArchive,
  onShare,
}: {
  onRename?: () => void;
  onArchive?: () => void;
  onShare?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Outside-click closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handlePick = useCallback((action?: () => void) => () => {
    setOpen(false);
    action?.();
  }, []);

  return (
    <div ref={wrapperRef} data-no-drag style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label="Conversation actions"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: 0,
          background: open || hovered ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-text-secondary)',
          cursor: 'pointer',
          padding: 0,
          transition: 'background 120ms ease',
        }}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="5" cy="12" r="1.2" />
          <circle cx="12" cy="12" r="1.2" />
          <circle cx="19" cy="12" r="1.2" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            minWidth: 168,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            background: 'var(--t-panel)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
            paddingTop: 4,
            paddingBottom: 4,
            zIndex: 100,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {onRename ? (
            <TitleMenuItem label="Rename" onClick={handlePick(onRename)} />
          ) : null}
          {onArchive ? (
            <TitleMenuItem label="Archive" onClick={handlePick(onArchive)} />
          ) : null}
          {onShare ? (
            <TitleMenuItem label="Share session" onClick={handlePick(onShare)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TitleMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 12,
        paddingRight: 12,
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: 0,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      {label}
    </button>
  );
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
