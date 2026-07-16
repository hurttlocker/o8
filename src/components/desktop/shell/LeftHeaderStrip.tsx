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
      // Strip height 32 — the toggle pill centers at ~y=20. The traffic
      // lights center on the same line: tao's inset semantics are
      // center = (buttonHeight + y) / 2 (bitmap-verified 2026-07-15: y=15
      // measured center 14.75, NOT y+6 — the y=15 attempt overshot UP by
      // ~5pt), so conf y=25 puts the ~14.5pt buttons at center ~19.75.
      // Calibrated at 100% zoom; zoom-tracking via runtime repositioning
      // was tried (0.1.605) and REVERTED — resizing the titlebar container
      // outside tao's draw_rect left the webview under-filling the window.
      height={32}
      left={
        <>
          {/* Spacer for the macOS traffic lights (close / minimize / maximize).
              Lights drawn by the OS at window-x ~14–68 (post trafficLightPosition
              shift). With the panel card's 5px paddingLeft + the strip's 8px
              paddingLeft, the strip content starts at window-x = 13. Spacer
              clears the lights and leaves the toggle pill ~10px right of the
              green light, matching Claude's tight cluster. Sized in SCREEN
              pixels (× --zoom-inverse): the lights are native and ignore CSS
              zoom, so a fixed 64px shrank at 80% zoom and the toggle
              overlapped the green light (2026-07-15). */}
          <div style={{ width: 'calc(64px * var(--zoom-inverse, 1))', flexShrink: 0 }} />
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
