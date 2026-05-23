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

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChromeButton } from './chrome/ChromeButton';
import { MergeActionCluster } from './MergeActionCluster';
import { FooterPorts } from './desktop-status-bar/footer-ports';
import { SupervisorInboxBadge } from './desktop-status-bar/supervisor-inbox-badge';
import { DeviceMobileIcon, FolderPlusIcon, GearSixIcon } from './desktop-status-bar/status-bar-icons';
import { SettingsQuickDrawer } from './SettingsQuickDrawer';

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
  /** Open the keyboard-shortcuts reference overlay (also bound to ⌘/). */
  onOpenShortcuts?: () => void;
}

function DesktopStatusBarBase({
  branchName,
  repoName,
  repoRemoteUrl = null,
  bottomPanelVisible = false,
  onToggleBottomPanel,
  onOpenShortcuts,
  leftColumnWidth,
  rightColumnWidth,
  compact = false,
  onOpenSettings,
  onAddRepo,
  onOpenMobilePairing,
  onPortPreview,
}: DesktopStatusBarProps) {
  const settingsButtonRef = useRef<HTMLDivElement | null>(null);
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
  const [settingsAnchorRect, setSettingsAnchorRect] = useState<DOMRect | null>(null);

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
        height: 28,
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
      <div
        style={{
          width: compact ? 'auto' : leftColumnWidth,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 12,
          paddingRight: 12,
          overflow: 'hidden',
          transform: 'translateY(-8px)',
        }}
      >
        <div ref={settingsButtonRef} style={{ display: 'flex', alignItems: 'center' }}>
          <ChromeButton
            icon={<GearSixIcon size={15} color="var(--t-text)" />}
            label="Settings"
            active={settingsDrawerOpen}
            onClick={toggleSettingsDrawer}
            size={28}
            radius={8}
          />
        </div>
        <SettingsQuickDrawer
          open={settingsDrawerOpen}
          anchorRect={settingsAnchorRect}
          onClose={closeSettingsDrawer}
          onOpenSettings={openFullSettings}
        />
        {!compact ? (
          <>
            <ChromeButton
              icon={<DeviceMobileIcon size={15} />}
              label="Pair mobile device"
              onClick={onOpenMobilePairing}
              size={28}
              radius={8}
            />
            <ChromeButton
              icon={<FolderPlusIcon size={15} color="var(--t-text)" />}
              label="Add repository"
              onClick={onAddRepo}
              size={28}
              radius={8}
            />
            <FooterPorts onPortPreview={onPortPreview} />
            <SupervisorInboxBadge />
          </>
        ) : null}
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
        <MergeActionCluster
          branchName={branchName}
          repoName={repoName}
          repoRemoteUrl={repoRemoteUrl}
          compact={compact}
        />
        {!compact && onToggleBottomPanel ? (
          <StatusTerminalToggle
            active={bottomPanelVisible}
            onClick={onToggleBottomPanel}
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

/** Terminal toggle pill that lives alongside the branch label in the
 *  status bar's center column. Chrome-less by design — just the icon,
 *  hover tints the background. Operator wanted it down here next to
 *  "main" rather than floating mid-workspace. */
function StatusTerminalToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="Toggle terminal"
      title="Toggle terminal (⌘J)"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: active ? 'var(--t-accent)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m4 17 6-6-6-6" />
        <line x1="12" x2="20" y1="19" y2="19" />
      </svg>
    </button>
  );
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
