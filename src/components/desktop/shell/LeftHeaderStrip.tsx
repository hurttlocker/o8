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
  /**
   * Forwarded to SidebarTogglePill so callers can compensate when the
   * containing card's paddingTop changes. Default -2 matches the original
   * 5px paddingTop card. The production dashboard now passes -6 because the
   * card's paddingTop was bumped from 5 → 9 for outer breathing room
   * (2026-05-27) and we want the pill to stay at the same window-y as the
   * WorkspaceHeaderStrip pill when the sidebar collapses.
   */
  togglePillYNudge?: number;
}

export function LeftHeaderStrip({ sidebarVisible = true, onToggleSidebar, togglePillYNudge }: LeftHeaderStripProps) {
  return (
    <ColumnHeaderStrip
      drag
      // Strip height 32 — pulls the toggle pill up 1px to y=8 so it visually
      // shifts higher in the card chrome after the traffic lights moved down
      // to y=22. The workspace pills stay at y=9 (their strip is still 36),
      // delta vs the toggle is now -1px (toggle slightly higher) which the
      // operator wants given the new light position.
      height={32}
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
            yNudge={togglePillYNudge}
          />
        </>
      }
    />
  );
}
