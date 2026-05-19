'use client';

/**
 * WorkspaceHeaderStrip — header strip for the center workspace column.
 * Hosts the Agents "home" control and the terminal toggle. Part of epic #1089.
 */

import { motion } from 'framer-motion';
import { UsersThree } from '@phosphor-icons/react';
import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { TitleBarButton } from '../title-bar/TitleBarButton';
import { IconTerminal } from '../title-bar/icons';

interface WorkspaceHeaderStripProps {
  isAgentsSectionActive?: boolean;
  onOpenAgents?: () => void;
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
}

export function WorkspaceHeaderStrip({
  isAgentsSectionActive = false,
  onOpenAgents,
  bottomPanelVisible = true,
  onToggleBottomPanel,
}: WorkspaceHeaderStripProps) {
  return (
    <ColumnHeaderStrip
      drag
      left={
        onOpenAgents ? (
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
        ) : null
      }
      right={
        <TitleBarButton
          icon={<IconTerminal />}
          label="Toggle terminal"
          onClick={onToggleBottomPanel}
          active={bottomPanelVisible}
        />
      }
    />
  );
}
