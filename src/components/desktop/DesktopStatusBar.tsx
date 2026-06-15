'use client';

/**
 * DesktopStatusBar — compact chrome strip pinned to the bottom of the dashboard.
 *
 * Mirrors the compact TitleBar controls at the top but lives at the foot of
 * the flex column.
 *
 *   [⚙] [🟢 N]  [+]                                  [⎇ branch-name]
 *     settings ports addRepo                         current branch
 *
 * Content migrated here from the retired NavRail (settings, ports, alerts
 * all used to live on the left side column). Every button uses the
 * shared ChromeButton so the style matches TitleBar + future WorkspaceTerminal
 * tabs.
 */

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChromeButton } from './chrome/ChromeButton';
import { MergeActionCluster } from './MergeActionCluster';
import { MergeBeacon } from './merge-beacon/MergeBeacon';
import type { ParkedLane } from './merge-beacon/derive';
import { FooterPorts } from './desktop-status-bar/footer-ports';
import { SupervisorInboxBadge } from './desktop-status-bar/supervisor-inbox-badge';
import { CanvasModeIcon, DeviceMobileIcon, FolderPlusIcon, GearSixIcon } from './desktop-status-bar/status-bar-icons';
import { useExperimentalCanvasFlag } from '@/lib/operator/use-experimental-canvas';
import { Terminal as TablerTerminal } from './tabler-shims';
import { CircleSpark, DoubleCheck, Folder, Internet } from 'iconoir-react';
import { SettingsQuickDrawer } from './SettingsQuickDrawer';
import type { BottomPanelSurfaceKind } from './ContextualPanel';

const COLLAPSED_LEFT_FOOTER_WIDTH = 34;

interface DesktopStatusBarProps {
  branchName: string | null;
  repoName: string | null;
  repoRemoteUrl?: string | null;
  /** Width of the left AgentPanel column, in CSS px. The bottom bar uses
   *  this to align its left chrome with the column above so the centered
   *  merge cluster lands directly under the workspace surface. */
  leftColumnWidth?: number;
  /** Width of the right panel column when visible, in CSS px. */
  rightColumnWidth?: number;
  /** Narrow desktop mode: keep durable status text and collapse action chrome. */
  compact?: boolean;
  /** Lanes parked in the review/escalation gates — drives the merge beacon
   *  (fleet-wide "something's ready to merge / needs you" pill). */
  parkedLanes?: ParkedLane[];
  onOpenSettings: () => void;
  onAddRepo: () => void;
  /** Open the full-screen mobile-pairing QR view (a canvas tab). */
  onOpenMobilePairing: () => void;
  onPortPreview?: (port: number, url: string, repo?: string) => void;
  /** Contextual bottom-panel (terminal) toggle. Moved from the column
   *  header per operator request — sits in the status bar's center
   *  column next to the branch label. */
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
  onOpenBottomPanelSurface?: (surface: BottomPanelSurfaceKind) => void;
  /** Open the keyboard-shortcuts reference overlay (also bound to ⌘/). */
  onOpenShortcuts?: () => void;
}

function DesktopStatusBarBase({
  branchName,
  repoName,
  repoRemoteUrl = null,
  bottomPanelVisible = false,
  onToggleBottomPanel,
  onOpenBottomPanelSurface,
  onOpenShortcuts,
  leftColumnWidth,
  rightColumnWidth,
  compact = false,
  parkedLanes = [],
  onOpenSettings,
  onAddRepo,
  onOpenMobilePairing,
  onPortPreview,
}: DesktopStatusBarProps) {
  const settingsButtonRef = useRef<HTMLDivElement | null>(null);
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
  const [settingsAnchorRect, setSettingsAnchorRect] = useState<DOMRect | null>(null);
  const experimentalCanvas = useExperimentalCanvasFlag();
  const leftFooterCollapsed = !compact && (leftColumnWidth ?? 0) <= 0;
  const leftFooterWidth = compact
    ? 'auto'
    : leftFooterCollapsed
      ? COLLAPSED_LEFT_FOOTER_WIDTH
      : leftColumnWidth;

  const syncSettingsAnchor = useCallback(() => {
    setSettingsAnchorRect(settingsButtonRef.current?.getBoundingClientRect() ?? null);
  }, []);

  const toggleSettingsDrawer = useCallback(() => {
    syncSettingsAnchor();
    setSettingsDrawerOpen((open) => !open);
  }, [syncSettingsAnchor]);

  const closeSettingsDrawer = useCallback(() => {
    setSettingsDrawerOpen(false);
  }, []);

  const openFullSettings = useCallback(() => {
    setSettingsDrawerOpen(false);
    onOpenSettings();
  }, [onOpenSettings]);

  useEffect(() => {
    if (!settingsDrawerOpen) return;
    window.addEventListener('resize', syncSettingsAnchor);
    window.addEventListener('scroll', syncSettingsAnchor, true);
    return () => {
      window.removeEventListener('resize', syncSettingsAnchor);
      window.removeEventListener('scroll', syncSettingsAnchor, true);
    };
  }, [settingsDrawerOpen, syncSettingsAnchor]);

  // Three-column footer that mirrors the dashboard layout above. Left section
  // takes the AgentPanel's exact width, right section takes the right-panel's
  // width (or 0 when hidden), so the center section spans the same horizontal
  // range as the workspace surface — and the merge cluster lands centered
  // directly under the chat / orchestrator.
  return (
    <div
      data-mcp-scope="desktop-status-bar"
      data-chrome-surface="true"
      data-stationary-chrome="true"
      style={{
        // Bumped from 28 → 36 so the footer card (= 36 - 5 = 31 tall) fits
        // the 28px tall FooterPorts + SupervisorInboxBadge cleanly without
        // them spilling out of the card's rounded bottom.
        height: 36,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        background: 'transparent',
        borderTopWidth: 0,
        fontFamily: 'var(--font-sans-system)',
        boxSizing: 'border-box',
      }}
    >
      {/* Left footer — bottom half of the SAME visual card as the panel
          above. Flat top corners (meet the panel card flush), rounded
          bottom corners. A thin top border draws the divider between
          panel content and footer buttons. */}
      <div
        style={{
          width: leftFooterWidth,
          flexShrink: 0,
          display: 'flex',
          // Buffer mirrors the panel card's: 5px on left/right/bottom,
          // 0 on top so this card meets the panel card with no gap.
          paddingTop: 0,
          paddingRight: 5,
          paddingBottom: 5,
          paddingLeft: 5,
          overflow: 'visible',
        }}
      >
        <div
          // Inner card — flat top (merges with panel above), rounded bottom.
          // Centered cluster — buttons sit in the middle of the footer, not
          // crammed left like a traditional status bar.
          //
          // When the sidebar column is collapsed (leftFooterCollapsed=true)
          // we drop the solid paper card entirely — just the gear icon
          // floats in transparent space. The merged-card design only makes
          // sense when there's a panel above to merge with. 2026-05-27.
          //
          // Token overrides flatten any chrome-btn-styled descendants (the
          // SupervisorInboxBadge especially renders a solid white pill with
          // shadow in its inactive state — those tokens are appropriate over
          // vibrancy chrome but look like a floating tile on the solid card).
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: leftFooterCollapsed ? 0 : 6,
            paddingLeft: leftFooterCollapsed ? 0 : 10,
            paddingRight: leftFooterCollapsed ? 0 : 10,
            background: leftFooterCollapsed ? 'transparent' : 'var(--t-panel-solid)',
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
            borderBottomLeftRadius: leftFooterCollapsed ? 0 : 14,
            borderBottomRightRadius: leftFooterCollapsed ? 0 : 14,
            borderTop: leftFooterCollapsed ? 'none' : '0.5px solid var(--t-divider-subtle)',
            boxShadow: leftFooterCollapsed ? 'none' : '0 8px 28px rgba(15, 23, 42, 0.10), 0 2px 6px rgba(15, 23, 42, 0.06)',
            ['--t-chrome-btn-bg' as string]: 'transparent',
            ['--t-chrome-btn-shadow' as string]: 'none',
            ['--t-chrome-btn-hover-bg' as string]: 'var(--t-hover)',
            ['--t-chrome-btn-hover-shadow' as string]: 'none',
          }}
        >
          <div ref={settingsButtonRef} style={{ display: 'flex', alignItems: 'center' }}>
            <ChromeButton
              icon={<GearSixIcon size={14} color="var(--t-text)" />}
              label="Settings"
              active={settingsDrawerOpen}
              onClick={toggleSettingsDrawer}
              size={22}
              radius={6}
            />
          </div>
          <SettingsQuickDrawer
            open={settingsDrawerOpen}
            anchorRect={settingsAnchorRect}
            onClose={closeSettingsDrawer}
            onOpenSettings={openFullSettings}
          />
          {!compact && !leftFooterCollapsed ? (
            <>
              <ChromeButton
                icon={<DeviceMobileIcon size={14} />}
                label="Pair mobile device"
                onClick={onOpenMobilePairing}
                size={22}
                radius={6}
              />
              <ChromeButton
                icon={<FolderPlusIcon size={14} color="var(--t-text)" />}
                label="Add repository"
                onClick={onAddRepo}
                size={22}
                radius={6}
              />
              {experimentalCanvas ? (
                <ChromeButton
                  icon={<CanvasModeIcon size={14} color="var(--t-text)" />}
                  label="Canvas mode"
                  onClick={() => { window.location.assign('/preview/canvas-glass'); }}
                  size={22}
                  radius={6}
                />
              ) : null}
              {/* Ports count + supervisor inbox merged as one cluster — both pills
                  share dims (26h / 7r / 11/300 chrome label) and the wrapper has
                  flexShrink:0 + gap:4 so they stay locked together when the panel
                  width changes. Per operator note 2026-05-27. */}
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  flexShrink: 0,
                }}
              >
                <FooterPorts onPortPreview={onPortPreview} />
                <SupervisorInboxBadge />
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        <MergeBeacon parked={parkedLanes} compact={compact} />
        <MergeActionCluster
          branchName={branchName}
          repoName={repoName}
          repoRemoteUrl={repoRemoteUrl}
          compact={compact}
        />
        {!compact && onToggleBottomPanel ? (
          <StatusBottomPanelControl
            active={bottomPanelVisible}
            onToggle={onToggleBottomPanel}
            onOpenSurface={onOpenBottomPanelSurface}
          />
        ) : null}
      </div>

      <div
        style={{
          width: compact ? 0 : (rightColumnWidth ?? undefined),
          flexShrink: 0,
          display: compact ? 'none' : 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingLeft: compact ? 0 : 12,
          paddingRight: compact ? 0 : 12,
          gap: 6,
        }}
      >
        {onOpenShortcuts ? <StatusShortcutsButton onClick={onOpenShortcuts} /> : null}
      </div>
    </div>
  );
}

export const DesktopStatusBar = memo(DesktopStatusBarBase);

const BOTTOM_PANEL_OPTIONS: Array<{
  id: BottomPanelSurfaceKind;
  label: string;
  detail: string;
  icon: (size?: number) => ReactNode;
}> = [
  { id: 'files', label: 'Files', detail: 'Browse project files', icon: (size = 14) => <FilesGlyph size={size} /> },
  { id: 'side-chat', label: 'Side chat', detail: 'Start a side conversation', icon: (size = 14) => <ChatGlyph size={size} /> },
  { id: 'browser', label: 'Browser', detail: 'Open a website', icon: (size = 14) => <BrowserGlyph size={size} /> },
  { id: 'review', label: 'Review', detail: 'View code changes', icon: (size = 14) => <ReviewGlyph size={size} /> },
  { id: 'terminal', label: 'Terminal', detail: 'Start an interactive shell', icon: (size = 14) => <TerminalGlyph size={size} /> },
];

/** Bottom panel control modeled after the Codex bottom-panel affordance:
 *  primary click toggles the drawer, chevron opens the surface picker. */
function StatusBottomPanelControl({
  active,
  onToggle,
  onOpenSurface,
}: {
  active: boolean;
  onToggle: () => void;
  onOpenSurface?: (surface: BottomPanelSurfaceKind) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  const openSurface = (surface: BottomPanelSurfaceKind) => {
    setMenuOpen(false);
    onOpenSurface?.(surface);
  };

  return (
    <div ref={menuRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          height: 26,
          borderRadius: 8,
          background: hovered || menuOpen ? 'var(--t-hover)' : 'transparent',
          color: active ? 'var(--t-accent)' : 'var(--t-text-secondary)',
          transition: 'background 120ms ease, color 120ms ease',
          overflow: 'hidden',
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label="Toggle bottom panel"
          title="Toggle bottom panel"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 26,
            borderWidth: 0,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <TerminalGlyph size={14} />
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label="Choose bottom panel surface"
          title="Choose bottom panel surface"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 26,
            borderWidth: 0,
            borderLeft: '1px solid var(--t-divider-subtle)',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      {menuOpen ? (
        <div
          role="menu"
          style={{
            position: 'absolute',
            bottom: 34,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 520,
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 8,
            padding: 10,
            borderRadius: 14,
            background: 'var(--t-panel-solid)',
            border: '1px solid var(--t-panel-border)',
            boxShadow: 'var(--t-panel-shadow), 0 18px 44px rgba(15, 23, 42, 0.20)',
            zIndex: 120,
          }}
        >
          {BOTTOM_PANEL_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitem"
              onClick={() => openSurface(option.id)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                minHeight: 96,
                borderRadius: 10,
                border: '1px solid transparent',
                background: 'color-mix(in srgb, var(--t-panel) 70%, transparent)',
                color: 'var(--t-text)',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
                textAlign: 'center',
                padding: 10,
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--t-hover)';
                event.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'color-mix(in srgb, var(--t-panel) 70%, transparent)';
                event.currentTarget.style.borderColor = 'transparent';
              }}
            >
              <span style={{ color: 'var(--t-text-secondary)' }}>{option.icon(18)}</span>
              <span style={{ fontSize: 13, lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px' }}>{option.label}</span>
              <span style={{ fontSize: 9.5, lineHeight: 1.25, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-muted)' }}>{option.detail}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TerminalGlyph({ size = 14 }: { size?: number }) {
  // Tabler Terminal2 — operator-locked icon for the bottom-area
  // terminal affordance. See Hurttlocker.md§"Icon vocabulary".
  return <TablerTerminal size={size} strokeWidth={2} />;
}

// Locked Iconoir picks per hurttlocker.md — same set used in O8Panel's
// RightUtilityLauncher so both surfaces share an icon vocabulary.

function FilesGlyph({ size = 14 }: { size?: number }) {
  return <Folder width={size} height={size} color="currentColor" strokeWidth={1.6} />;
}

function ChatGlyph({ size = 14 }: { size?: number }) {
  return <CircleSpark width={size} height={size} color="currentColor" strokeWidth={1.6} />;
}

function BrowserGlyph({ size = 14 }: { size?: number }) {
  return <Internet width={size} height={size} color="currentColor" strokeWidth={1.6} />;
}

function ReviewGlyph({ size = 14 }: { size?: number }) {
  return <DoubleCheck width={size} height={size} color="currentColor" strokeWidth={1.6} />;
}

/** `?` button — opens the keyboard-shortcuts reference. Sits at the
 *  right edge of the status bar where global help affordances belong. */
function StatusShortcutsButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="Keyboard shortcuts"
      aria-haspopup="dialog"
      title="Keyboard shortcuts (⌘/)"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: hovered ? 'var(--t-text)' : 'var(--t-text-faint)',
        cursor: 'pointer',
        padding: 0,
        fontSize: 12,
        fontWeight: 700,
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      ?
    </button>
  );
}
