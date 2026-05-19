'use client';

/**
 * TitleBar — Topmost bar across the entire application.
 *
 * Layout (matching Cursor/Claude Code pattern):
 * Left:  [78px traffic light spacer] [Sidebar toggle] [← Back] [→ Forward]
 * Center: drag region
 * Right: [Bottom panel toggle] [Chat toggle] [Settings gear (red)]
 *
 * Sits ABOVE everything. Height: 44px. Frosted glass.
 */

import { useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { UsersThree } from '@phosphor-icons/react';
import { O8HeaderTabs } from './o8-panel/O8HeaderTabs';
import type { O8Tab } from './o8-panel/types';
import { IconPanelLeft, IconTerminal } from './title-bar/icons';
import { TitleBarButton } from './title-bar/TitleBarButton';
import { BrowserHoverButton } from './title-bar/BrowserHoverButton';
import { RightPanelMorphButton } from './title-bar/RightPanelMorphButton';

// ── Types ──

interface TitleBarProps {
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
  o8ActiveTab?: O8Tab;
  onO8TabChange?: (tab: O8Tab) => void;
  compact?: boolean;
}

// ── Main Component ──

export function TitleBar({
  sidebarVisible = true,
  onToggleSidebar,
  bottomPanelVisible = true,
  onToggleBottomPanel,
  workspacePanelVisible = false,
  o8PanelVisible = false,
  onToggleO8Panel,
  browserActive = false,
  browserPreviewUrl,
  onOpenBrowser,
  isAgentsSectionActive = false,
  onOpenAgents,
  o8ActiveTab = 'workspace',
  onO8TabChange,
  compact = false,
}: TitleBarProps) {
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

  return (
    <header
      ref={headerRef}
      data-tauri-drag-region=""
      data-stationary-chrome="true"
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
          gap: 4,
          flexShrink: 0,
        }}
      >
        {/* Spacer for macOS traffic lights (close/minimize/maximize) */}
        <div style={{ width: 78, flexShrink: 0 }} />


        {/* Sidebar toggle */}
        {!compact ? (
          <TitleBarButton
            icon={<IconPanelLeft />}
            label="Toggle sidebar"
            onClick={onToggleSidebar}
            active={sidebarVisible}
          />
        ) : null}

        {/* Agents — returns the center workspace to the main agents view.
            Lives here instead of the retired NavRail so users always have a
            one-click "home" back to the three-pane workspace from Settings. */}
        {!compact && onOpenAgents ? (
          <TitleBarButton
            icon={
              <motion.span
                variants={{
                  rest: { opacity: 1 },
                  hover: { opacity: 1 },
                  active: { opacity: 1 },
                }}
                transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                style={{ display: 'inline-flex' }}
              >
                <UsersThree
                  size={16}
                  weight={isAgentsSectionActive ? 'fill' : 'bold'}
                  color={isAgentsSectionActive ? 'var(--t-brand-orange, #FF5A1F)' : 'currentColor'}
                />
              </motion.span>
            }
            label="Agents"
            onClick={onOpenAgents}
            active={isAgentsSectionActive}
            accent="orange"
          />
        ) : null}

      </div>

      {/* ── Center — quiet drag region. Search lives in the left rail. ── */}
      <div
        data-chrome-surface="true"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 0,
        }}
      />

      {/* Open In — moved to Command Palette (⌘K → "open in") */}

      {/* ── Right controls ── */}
      <div
        data-chrome-surface="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          flexShrink: 0,
          paddingRight: 4,
        }}
      >
        {!compact && o8PanelVisible && onO8TabChange ? (
          <O8HeaderTabs activeTab={o8ActiveTab} onTabChange={onO8TabChange} />
        ) : null}
        {!compact && onOpenBrowser ? (
          <BrowserHoverButton
            active={browserActive}
            url={browserPreviewUrl ?? null}
            onClick={onOpenBrowser}
          />
        ) : null}
        <TitleBarButton
          icon={<IconTerminal />}
          label="Toggle terminal"
          onClick={onToggleBottomPanel}
          active={bottomPanelVisible}
        />
        {!compact ? (
          <RightPanelMorphButton
            workspacePanelVisible={workspacePanelVisible}
            o8PanelVisible={o8PanelVisible}
            onToggleO8Panel={onToggleO8Panel}
          />
        ) : null}

      </div>
    </header>
  );
}
