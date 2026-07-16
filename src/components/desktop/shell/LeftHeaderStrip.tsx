'use client';

/**
 * LeftHeaderStrip — header strip for the left (nav / AgentPanel) column.
 * Hosts the macOS traffic-light inset and the sidebar toggle. Part of epic #1089.
 */

import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { SidebarTogglePill } from './SidebarTogglePill';
import { TrafficLightsOrSpacer } from './TrafficLights';

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
          {/* Traffic lights: DOM-rendered when the shell hides the native
              ones (they scale with CSS zoom like everything else — Q ruling
              2026-07-16); legacy screen-pixel spacer clearing the native
              lights on older shells. Same yNudge as the toggle pill so both
              centers ride the same line. leadInPx 6 (not the default 1): the
              left column is FLUSH to the window edge now (dock ruling
              2026-07-16), so strip content starts at window-x 8, and 8+6
              puts the first light back at 14 — matching the workspace strip
              so the cluster doesn't jump when the sidebar collapses.
              See TrafficLights.tsx. */}
          <TrafficLightsOrSpacer yNudge={togglePillYNudge ?? 3.3} leadInPx={6} />
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
