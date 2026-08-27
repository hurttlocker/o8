export interface WorkspaceHeaderStripProps {
  /** Render the 78px macOS traffic-light spacer. Set when this strip is leftmost. */
  leadingInset?: boolean;
  /** Sidebar toggle. Shown only when a handler is provided (left column collapsed). */
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  /** When the sidebar is collapsed, hovering the toggle pill drops the
   *  hover-preview overlay. These handlers wire that trigger to the same
   *  callbacks the overlay itself uses, so moving between pill and overlay
   *  does not dismiss it. */
  onSidebarHoverEnter?: () => void;
  onSidebarHoverLeave?: () => void;
  /** Terminal toggle. Shown only when a handler is provided. */
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
  /** Split the active workspace tile into a second pane. */
  onSplitWorkspacePanel?: () => void;
  /** O8 panel re-open toggle. Rendered as the rightmost icon only when the
   *  panel is collapsed, because the open panel owns its toggle. */
  rightPanelOpen?: boolean;
  onToggleRightPanel?: () => void;
  /** Pending approvals badge shown only when the right panel header is absent. */
  approvalCount?: number;
  onOpenInbox?: () => void;
  /** Active workspace tab title rendered in the center slot. */
  headerLabel?: string | null;
  /** Full visible-tab list for the single workspace. */
  headerTabs?: Array<{
    id: string;
    label: string;
    kind: string;
    runtime: string | null;
    packetStatus: string | null;
  }>;
  /** Stable workspace id for routing header pill events back to the owning tile. */
  workspaceId?: string | null;
  terminalModeActive?: boolean;
  /** Active tab id from the headerTabs list. */
  headerActiveTabId?: string | null;
  /** Number of non-active finished CLI-session tabs eligible for explicit cleanup. */
  finishedTabCount?: number;
  /** Header-owned toggle for the project context rail. */
  projectContextRailAvailable?: boolean;
  projectContextRailVisible?: boolean;
  onToggleProjectContextRail?: () => void;
  /** Side-by-side pill strips for split workspaces. */
  splitHeaderWorkspaces?: Array<{
    workspaceId: string;
    tabs: Array<{
      id: string;
      label: string;
      kind: string;
      runtime: string | null;
      packetStatus: string | null;
    }>;
    activeTabId: string | null;
    finishedTabCount?: number;
    contextRailAvailable?: boolean;
    contextRailVisible?: boolean;
    terminalModeActive?: boolean;
  }> | null;
}
