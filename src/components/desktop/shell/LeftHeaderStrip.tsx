'use client';

/**
 * LeftHeaderStrip — header strip for the left (nav / AgentPanel) column.
 * Hosts the macOS traffic-light inset and the sidebar toggle. Part of epic #1089.
 */

import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { SidebarTogglePill } from './SidebarTogglePill';

interface LeftHeaderStripProps {
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
}

export function LeftHeaderStrip({ sidebarVisible = true, onToggleSidebar }: LeftHeaderStripProps) {
  return (
    <ColumnHeaderStrip
      drag
      // Strip height 34 (the workspace strip is 36, but the workspace area
      // sits at window-y=4 while this card sits at y=5 — losing 1px each
      // side of the 26px pill brings the pill to y=9 to match the
      // Orchestrator pill across the column boundary).
      height={34}
      left={
        <>
          {/* Spacer for the macOS traffic lights (close / minimize / maximize).
              Lights drawn by the OS at window-x ~14–68 (post trafficLightPosition
              shift). With the panel card's 5px paddingLeft + the strip's 8px
              paddingLeft, the strip content starts at window-x = 13. Spacer
              clears the lights and leaves the toggle pill ~10px right of the
              green light, matching Claude's tight cluster. */}
          <div style={{ width: 64, flexShrink: 0 }} />
          <SidebarTogglePill
            sidebarVisible={sidebarVisible}
            onClick={onToggleSidebar}
          />
        </>
      }
    />
  );
}
