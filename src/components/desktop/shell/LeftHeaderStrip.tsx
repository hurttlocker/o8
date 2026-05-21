'use client';

/**
 * LeftHeaderStrip — header strip for the left (nav / AgentPanel) column.
 * Hosts the macOS traffic-light inset and the sidebar toggle. Part of epic #1089.
 */

import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { TitleBarButton } from '../title-bar/TitleBarButton';
import { IconPanelLeft } from '../title-bar/icons';

interface LeftHeaderStripProps {
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
}

export function LeftHeaderStrip({ sidebarVisible = true, onToggleSidebar }: LeftHeaderStripProps) {
  return (
    <ColumnHeaderStrip
      drag
      left={
        <>
          {/* Spacer for the macOS traffic lights (close / minimize / maximize) */}
          <div style={{ width: 78, flexShrink: 0 }} />
          <TitleBarButton
            icon={<IconPanelLeft />}
            label="Toggle sidebar"
            title="Toggle sidebar (⌘B)"
            onClick={onToggleSidebar}
            active={sidebarVisible}
          />
        </>
      }
    />
  );
}
