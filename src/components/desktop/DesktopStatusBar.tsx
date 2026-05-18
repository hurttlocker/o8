'use client';

/**
 * DesktopStatusBar — 28px chrome strip pinned to the bottom of the dashboard.
 *
 * Mirrors the TitleBar pattern at the top (transparent background, neomorphic
 * buttons) but lives at the foot of the flex column.
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
import { FolderPlus, GearSix } from '@phosphor-icons/react';
import { Smartphone } from './lucide-shims';
import { ChromeButton } from './chrome/ChromeButton';
import { MergeActionCluster } from './MergeActionCluster';
import { FooterPorts } from './desktop-status-bar/footer-ports';
import { SupervisorInboxBadge } from './desktop-status-bar/supervisor-inbox-badge';
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
  /** Narrow desktop mode: keep only durable, terminal-like status chrome. */
  compact?: boolean;
  onOpenSettings: () => void;
  onAddRepo: () => void;
  /** Open the full-screen mobile-pairing QR view (a canvas tab). */
  onOpenMobilePairing: () => void;
  onPortPreview?: (port: number, url: string, repo?: string) => void;
}

function DesktopStatusBarBase({
  branchName,
  repoName,
  repoRemoteUrl = null,
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
        }}
      >
        <div ref={settingsButtonRef} style={{ display: 'flex', alignItems: 'center' }}>
          <ChromeButton
            icon={<GearSix size={14} weight="bold" color="var(--t-text)" />}
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
        {!compact ? (
          <>
            <ChromeButton
              icon={<Smartphone size={14} />}
              label="Pair mobile device"
              onClick={onOpenMobilePairing}
              size={22}
              radius={6}
            />
            <ChromeButton
              icon={<FolderPlus size={14} weight="bold" color="var(--t-text)" />}
              label="Add repository"
              onClick={onAddRepo}
              size={22}
              radius={6}
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
        }}
      >
        <MergeActionCluster
          branchName={branchName}
          repoName={repoName}
          repoRemoteUrl={repoRemoteUrl}
        />
      </div>

      <div
        style={{
          width: compact ? 0 : (rightColumnWidth ?? undefined),
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingLeft: 12,
          paddingRight: 12,
          gap: 6,
        }}
      >
      </div>
    </div>
  );
}

export const DesktopStatusBar = memo(DesktopStatusBarBase);
