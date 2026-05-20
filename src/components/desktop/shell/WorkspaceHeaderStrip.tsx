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
   *  separate strip below. Supports "repo / chat" split styling. */
  headerLabel?: string | null;
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
}: WorkspaceHeaderStripProps) {
  const showRightPanelFallbackToggle = !rightPanelOpen && Boolean(onToggleRightPanel);
  const hasTitleMenu = headerLabel && (onTitleRename || onTitleArchive || onTitleShare);
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
      center={headerLabel ? (
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
