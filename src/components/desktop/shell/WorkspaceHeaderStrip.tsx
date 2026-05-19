'use client';

/**
 * WorkspaceHeaderStrip — header strip for the center workspace column.
 * Hosts the Agents "home" control and the terminal toggle. When the left
 * column is collapsed this strip becomes the leftmost one, so it can also
 * carry the macOS traffic-light inset + the sidebar toggle. Part of epic #1089.
 *
 * Each control renders only when its handler prop is provided — that lets
 * the dashboard gate compact mode / sidebar-collapsed state from the call site.
 */

import { motion } from 'framer-motion';
import { UsersThree } from '@phosphor-icons/react';
import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { TitleBarButton } from '../title-bar/TitleBarButton';
import { IconPanelLeft, IconTerminal } from '../title-bar/icons';

interface WorkspaceHeaderStripProps {
  /** Render the 78px macOS traffic-light spacer — set when this strip is leftmost. */
  leadingInset?: boolean;
  /** Sidebar toggle — shown only when a handler is provided (left column collapsed). */
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  /** Agents "home" control — shown only when a handler is provided. */
  isAgentsSectionActive?: boolean;
  onOpenAgents?: () => void;
  /** Terminal toggle — shown only when a handler is provided. */
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
}

export function WorkspaceHeaderStrip({
  leadingInset = false,
  sidebarVisible = true,
  onToggleSidebar,
  isAgentsSectionActive = false,
  onOpenAgents,
  bottomPanelVisible = true,
  onToggleBottomPanel,
}: WorkspaceHeaderStripProps) {
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
          {onOpenAgents ? (
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
        </>
      }
      right={
        onToggleBottomPanel ? (
          <TitleBarButton
            icon={<IconTerminal />}
            label="Toggle terminal"
            onClick={onToggleBottomPanel}
            active={bottomPanelVisible}
          />
        ) : null
      }
    />
  );
}
