'use client';

/**
 * TitleBar — Topmost bar across the entire application.
 *
 * Layout (matching Cursor/Claude Code pattern):
 * Left:  [78px traffic light spacer] [Sidebar toggle] [← Back] [→ Forward]
 * Center: [Search pill / expanded UniversalSearch]
 * Right: [Bottom panel toggle] [Chat toggle] [Settings gear (red)]
 *
 * Sits ABOVE everything. Height: 44px. Frosted glass.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { UsersThree, GlobeSimple } from '@phosphor-icons/react';
import { ChromeButton } from './chrome/ChromeButton';

// ── Inline SVG icons (Tauri webview doesn't reliably render Lucide React components) ──

function IconPanelLeft({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

function IconSearch({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function IconTerminal({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function IconDelta({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5 18.5 18H5.5L12 5Z" />
      <path d="M8.5 14h7" />
    </svg>
  );
}

function IconPanelRightCollapse({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M16 4v16" />
      <path d="m10 9 3 3-3 3" />
    </svg>
  );
}

function IconColumns({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="3" width="7" height="18" rx="2" />
      <rect x="14" y="3" width="7" height="18" rx="2" />
    </svg>
  );
}

// ── Types ──

interface TitleBarProps {
  renderSearch?: (onClose: () => void) => React.ReactNode;
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
  chatVisible?: boolean;
  onToggleChat?: () => void;
  workspacePanelVisible?: boolean;
  onToggleWorkspacePanel?: () => void;
  o8PanelVisible?: boolean;
  onToggleO8Panel?: () => void;
  // Browser slot — pulls the Browser tab out of the O8 panel tab strip and
  // gives it a top-of-window perch so we can hover-extend it later.
  browserActive?: boolean;
  // Live URL of the wide O8 Panel's active browser tab; used to render the
  // hover-preview iframe under the button.
  browserPreviewUrl?: string | null;
  onOpenBrowser?: () => void;
  // Agents slot — migrated out of the NavRail.
  isAgentsSectionActive?: boolean;
  onOpenAgents?: () => void;
}

// ── Icon Button ──

// TitleBarButton is now a thin wrapper around the shared ChromeButton so
// every button in the title bar uses the same neomorphic look pioneered by
// the NavRail. Color / hoverBg props are ignored (the neomorphic preset
// handles all tint variants from the active theme), preserved only for
// existing callers that still pass them.
function TitleBarButton({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  color?: string;
  hoverBg?: string;
}) {
  return (
    <ChromeButton
      icon={icon}
      label={label}
      onClick={onClick}
      active={active}
      noDrag
    />
  );
}

// BrowserHoverButton — the TitleBar's globe button. Click acts the same as
// a normal chrome chip (open the wide O8 panel, focus its Browser tab),
// but hovering reveals a small floating iframe popover anchored beneath
// the button so you can peek at the running app without losing your
// workspace tab. Delays in/out keep the popover from flashing on
// incidental mouse-throughs.
const BROWSER_HOVER_OPEN_DELAY_MS = 220;
const BROWSER_HOVER_CLOSE_DELAY_MS = 160;
const BROWSER_HOVER_WIDTH = 480;
const BROWSER_HOVER_HEIGHT = 320;

function BrowserHoverButton({
  active,
  url,
  onClick,
}: {
  active: boolean;
  url: string | null | undefined;
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpenTimer = () => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };
  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleOpen = useCallback(() => {
    clearCloseTimer();
    if (open) return;
    clearOpenTimer();
    openTimerRef.current = setTimeout(() => {
      if (buttonRef.current) {
        setAnchorRect(buttonRef.current.getBoundingClientRect());
      }
      setOpen(true);
      openTimerRef.current = null;
    }, BROWSER_HOVER_OPEN_DELAY_MS);
  }, [open]);

  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, BROWSER_HOVER_CLOSE_DELAY_MS);
  }, []);

  useEffect(() => () => {
    clearOpenTimer();
    clearCloseTimer();
  }, []);

  const popoverLeft = anchorRect
    ? Math.max(8, Math.min(anchorRect.right - BROWSER_HOVER_WIDTH, window.innerWidth - BROWSER_HOVER_WIDTH - 8))
    : 8;
  const popoverTop = anchorRect ? anchorRect.bottom + 6 : 50;

  return (
    <span
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      style={{ display: 'inline-flex', position: 'relative' }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label="Browser"
        title="Browser"
        onClick={() => {
          // Click commits — close the hover popover so the wide panel slot
          // isn't double-rendering the same iframe for a frame.
          clearOpenTimer();
          setOpen(false);
          onClick?.();
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          padding: 0,
          border: 'none',
          borderRadius: 8,
          background: active ? 'var(--t-panel-active, var(--t-input-bg))' : 'transparent',
          color: active ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-text-secondary)',
          cursor: 'pointer',
          flexShrink: 0,
          WebkitTapHighlightColor: 'transparent',
          transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
          ['WebkitAppRegion' as string]: 'no-drag',
        }}
        onPointerEnter={(e) => {
          if (!active) {
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--t-hover)';
          }
        }}
        onPointerLeave={(e) => {
          if (!active) {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }
        }}
      >
        <GlobeSimple size={16} weight="bold" color={active ? 'var(--t-brand-orange, #FF5A1F)' : 'currentColor'} />
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          onMouseEnter={() => { clearCloseTimer(); }}
          onMouseLeave={scheduleClose}
          style={{
            position: 'fixed',
            top: popoverTop,
            left: popoverLeft,
            width: BROWSER_HOVER_WIDTH,
            height: BROWSER_HOVER_HEIGHT,
            borderRadius: 12,
            border: '1px solid var(--t-panel-border)',
            background: 'var(--t-panel-solid, #ffffff)',
            boxShadow: '0 18px 48px rgba(15, 23, 42, 0.22), 0 4px 12px rgba(15, 23, 42, 0.10)',
            overflow: 'hidden',
            zIndex: 9200,
            display: 'flex',
            flexDirection: 'column',
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingTop: 8,
              paddingRight: 10,
              paddingBottom: 8,
              paddingLeft: 12,
              borderBottom: '1px solid var(--t-divider-subtle)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--t-text)',
            }}
          >
            <GlobeSimple size={12} weight="bold" />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--t-text-muted)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                fontSize: 10.5,
                fontWeight: 500,
              }}
            >
              {url ?? 'No active preview'}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, background: 'var(--t-canvas-bg)' }}>
            {url ? (
              <iframe
                src={url}
                title="Browser preview"
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{
                  width: '100%',
                  height: '100%',
                  border: 'none',
                  display: 'block',
                }}
              />
            ) : (
              <div style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--t-text-muted)',
                fontSize: 12,
              }}>
                Open the Browser panel to start a preview
              </div>
            )}
          </div>
        </div>,
        document.body,
      ) : null}
    </span>
  );
}

function RightPanelMorphButton({
  workspacePanelVisible,
  o8PanelVisible,
  onToggleWorkspacePanel,
  onToggleO8Panel,
}: {
  workspacePanelVisible: boolean;
  o8PanelVisible: boolean;
  onToggleWorkspacePanel?: () => void;
  onToggleO8Panel?: () => void;
}) {
  // 3-state model kept for visual transitions, but the click action is now
  // a 2-state toggle: O8 ⇄ collapsed. The review/workspace side panel
  // surfaces (Changes / Git Log) open via repo-focus or commit clicks; the
  // header button is dedicated to O8 so first-click never lands on the
  // narrow rail by accident.
  const state: 'collapsed' | 'review' | 'o8' = o8PanelVisible
    ? 'o8'
    : workspacePanelVisible
      ? 'review'
      : 'collapsed';
  const panelOpen = state !== 'collapsed';
  const label = panelOpen ? 'Close panel' : 'Open O8 panel';
  const handleClick = onToggleO8Panel;

  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      onClick={handleClick}
      initial={false}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        padding: 0,
        border: 'none',
        borderRadius: 8,
        background: panelOpen ? 'var(--t-panel-active)' : 'transparent',
        color: panelOpen ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        flexShrink: 0,
        WebkitTapHighlightColor: 'transparent',
        transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
      onMouseEnter={(e) => {
        if (!panelOpen) {
          e.currentTarget.style.background = 'var(--t-hover)';
        }
      }}
      onMouseLeave={(e) => {
        if (!panelOpen) {
          e.currentTarget.style.background = 'transparent';
        }
      }}
    >
      <span style={{ position: 'relative', width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* Review (delta) icon */}
        <motion.span
          initial={false}
          animate={{
            opacity: state === 'review' ? 1 : 0,
            scale: state === 'review' ? 1 : 0.72,
            rotate: state === 'review' ? 0 : -12,
          }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconDelta />
        </motion.span>
        {/* O8 (columns) icon */}
        <motion.span
          initial={false}
          animate={{
            opacity: state === 'o8' ? 1 : 0,
            scale: state === 'o8' ? 1 : 0.72,
            rotate: state === 'o8' ? 0 : state === 'review' ? 12 : -12,
          }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconColumns />
        </motion.span>
        {/* Collapsed (panel) icon */}
        <motion.span
          initial={false}
          animate={{
            opacity: state === 'collapsed' ? 1 : 0,
            scale: state === 'collapsed' ? 1 : 0.72,
            rotate: state === 'collapsed' ? 0 : 12,
          }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconPanelRightCollapse />
        </motion.span>
      </span>
    </motion.button>
  );
}

// ── Main Component ──

export function TitleBar({
  renderSearch,
  sidebarVisible = true,
  onToggleSidebar,
  bottomPanelVisible = true,
  onToggleBottomPanel,
  workspacePanelVisible = false,
  onToggleWorkspacePanel,
  o8PanelVisible = false,
  onToggleO8Panel,
  browserActive = false,
  browserPreviewUrl,
  onOpenBrowser,
  isAgentsSectionActive = false,
  onOpenAgents,
}: TitleBarProps) {
  const [searchExpanded, setSearchExpanded] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  // Window drag — Tauri v2 startDragging API
  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    // Only drag from the header itself or non-interactive children
    const target = e.target as HTMLElement;
    // Skip if clicking a button, input, or anything interactive
    if (
      target.closest('button') ||
      target.closest('input') ||
      target.closest('kbd') ||
      target.closest('[data-no-drag]')
    ) {
      return;
    }
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().startDragging();
    } catch {
      // Not in Tauri — ignore (browser mode)
    }
  }, []);

  // ⌘K / ⇧⌘P keyboard shortcuts for the command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isCommandPaletteShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      const isShiftPaletteShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p';

      if (isCommandPaletteShortcut || isShiftPaletteShortcut) {
        e.preventDefault();
        setSearchExpanded(true);
      }
      if (e.key === 'Escape' && searchExpanded) {
        setSearchExpanded(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [searchExpanded]);

  const closeSearch = useCallback(() => setSearchExpanded(false), []);

  return (
    <header
      ref={headerRef}
      data-tauri-drag-region=""
      onMouseDown={handleMouseDown}
      style={{
        height: 44,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: 4,
        background: 'transparent',
        borderBottom: '0.5px solid rgba(0, 0, 0, 0.04)',
        zIndex: 9000,
        position: 'relative',
        ['WebkitAppRegion' as string]: 'drag',
      }}
    >
      {/* ── Left: Traffic light spacer + controls ── */}
      <div
        data-chrome-surface="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}
      >
        {/* Spacer for macOS traffic lights (close/minimize/maximize) */}
        <div style={{ width: 78, flexShrink: 0 }} />


        {/* Sidebar toggle */}
        <TitleBarButton
          icon={<IconPanelLeft />}
          label="Toggle sidebar"
          onClick={onToggleSidebar}
          active={sidebarVisible}
        />

        {/* Agents — returns the center workspace to the main agents view.
            Lives here instead of the retired NavRail so users always have a
            one-click "home" back to the three-pane workspace from Settings
            or Analytics. */}
        {onOpenAgents ? (
          <ChromeButton
            icon={<UsersThree size={18} weight={isAgentsSectionActive ? 'fill' : 'bold'} color={isAgentsSectionActive ? 'var(--t-accent)' : 'var(--t-text)'} />}
            label="Agents"
            onClick={onOpenAgents}
            active={isAgentsSectionActive}
            noDrag
          />
        ) : null}

        {/* Terminal toggle — lives next to Agents on the left so the whole
            "workspace shortcut" cluster is grouped together. */}
        <TitleBarButton
          icon={<IconTerminal />}
          label="Toggle terminal"
          onClick={onToggleBottomPanel}
          active={bottomPanelVisible}
        />
      </div>

      {/* ── Center — Search ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0,
      }}>
        <div style={{
          width: '100%',
          maxWidth: searchExpanded ? 640 : 320,
          transition: 'max-width 250ms cubic-bezier(0.22, 1, 0.36, 1)',
          position: 'relative',
        }}>
          {!searchExpanded ? (
            <button
              type="button"
              onClick={() => setSearchExpanded(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                paddingTop: 6,
                paddingBottom: 6,
                paddingLeft: 16,
                paddingRight: 16,
                borderRadius: 10,
                border: 'none',
                background: 'rgba(255, 255, 255, 0.06)',
                color: 'rgba(255, 255, 255, 0.78)',
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '-0.01em',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
                transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                width: '100%',
                justifyContent: 'center',
                ['WebkitAppRegion' as string]: 'no-drag',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
              }}
            >
              <IconSearch />
              <span>Command Palette</span>
              <kbd style={{
                fontSize: 10,
                fontWeight: 500,
                color: 'var(--t-kbd-color)',
                background: 'var(--t-kbd-bg)',
                border: '1px solid var(--t-kbd-border)',
                borderRadius: 4,
                padding: '1px 5px',
                marginLeft: 8,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}>
                ⌘K
              </kbd>
            </button>
          ) : (
            <div style={{ position: 'relative', ['WebkitAppRegion' as string]: 'no-drag' }}>
              {renderSearch ? renderSearch(closeSearch) : null}
            </div>
          )}
        </div>
      </div>

      {/* Open In — moved to Command Palette (⌘K → "open in") */}

      {/* ── Right controls ── */}
      <div
        data-chrome-surface="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flexShrink: 0,
          paddingRight: 4,
        }}
      >
        {onOpenBrowser ? (
          <BrowserHoverButton
            active={browserActive}
            url={browserPreviewUrl ?? null}
            onClick={onOpenBrowser}
          />
        ) : null}
        <RightPanelMorphButton
          workspacePanelVisible={workspacePanelVisible}
          o8PanelVisible={o8PanelVisible}
          onToggleWorkspacePanel={onToggleWorkspacePanel}
          onToggleO8Panel={onToggleO8Panel}
        />

      </div>

      {/* Backdrop — closes search when clicking outside */}
      {searchExpanded && (
        <div
          onClick={closeSearch}
          style={{
            position: 'fixed',
            inset: 0,
            top: 44,
            zIndex: -1,
          }}
        />
      )}
    </header>
  );
}
