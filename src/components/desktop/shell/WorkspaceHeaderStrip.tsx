'use client';

/**
 * WorkspaceHeaderStrip — header strip for the center workspace column.
 * Hosts workspace chrome like the terminal toggle. When the left column is
 * collapsed this strip becomes the leftmost one, so it can also carry the
 * macOS traffic-light inset + the sidebar toggle. Part of epic #1089.
 *
 * Each control renders only when its handler prop is provided — that lets
 * the dashboard gate compact mode / sidebar-collapsed state from the call site.
 */

import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { TitleBarButton } from '../title-bar/TitleBarButton';
import { IconColumns, IconPanelLeft, IconTerminal } from '../title-bar/icons';
import { RightPanelMorphButton } from '../title-bar/RightPanelMorphButton';

interface WorkspaceHeaderStripProps {
  /** Render the 78px macOS traffic-light spacer — set when this strip is leftmost. */
  leadingInset?: boolean;
  /** Sidebar toggle — shown only when a handler is provided (left column collapsed). */
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  /** Terminal toggle — shown only when a handler is provided. */
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
  /** Split the active workspace tile into a second pane. */
  onSplitWorkspacePanel?: () => void;
  /**
   * O8 panel re-open toggle. Rendered as the rightmost icon ONLY when the
   * panel is collapsed — when it's open, the toggle in PanelHeaderStrip is
   * already visible, so we don't duplicate. Operator regression catch
   * post-#1089: when the panel column disappears, its toggle goes with it,
   * leaving no re-open affordance.
   */
  rightPanelOpen?: boolean;
  onToggleRightPanel?: () => void;
  /** Active workspace tab title rendered in the center slot. Codex / Claude
   *  put the conversation name in the title bar itself instead of a
   *  separate strip below. Supports "repo / chat" split styling. */
  headerLabel?: string | null;
}

export function WorkspaceHeaderStrip({
  leadingInset = false,
  sidebarVisible = true,
  onToggleSidebar,
  bottomPanelVisible = true,
  onToggleBottomPanel,
  onSplitWorkspacePanel,
  rightPanelOpen = false,
  onToggleRightPanel,
  headerLabel,
}: WorkspaceHeaderStripProps) {
  const showRightPanelFallbackToggle = !rightPanelOpen && Boolean(onToggleRightPanel);
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
        </>
      }
      center={headerLabel ? <HeaderLabelText label={headerLabel} /> : null}
      right={
        onToggleBottomPanel || onSplitWorkspacePanel || showRightPanelFallbackToggle ? (
          <>
            {onToggleBottomPanel ? (
              <TitleBarButton
                icon={<IconTerminal />}
                label="Toggle terminal"
                onClick={onToggleBottomPanel}
                active={bottomPanelVisible}
              />
            ) : null}
            {onSplitWorkspacePanel ? (
              <TitleBarButton
                icon={<IconColumns />}
                label="Split workspace"
                onClick={onSplitWorkspacePanel}
              />
            ) : null}
            {showRightPanelFallbackToggle ? (
              <RightPanelMorphButton
                workspacePanelVisible={false}
                o8PanelVisible={false}
                onToggleO8Panel={onToggleRightPanel}
              />
            ) : null}
          </>
        ) : null
      }
    />
  );
}

// Codex-style "<repo> / <chat title>" split: repo gets emphasis, the
// separator is faint, the title is muted. Matches HeaderLabelText in
// TabBar.tsx — kept duplicated rather than shared since this strip
// renders at the column-shell layer (no workspace-terminal import).
function HeaderLabelText({ label }: { label: string }) {
  const separator = ' / ';
  const separatorIndex = label.indexOf(separator);
  if (separatorIndex < 0) {
    return (
      <span
        title={label}
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--t-text)',
          fontWeight: 500,
          fontSize: 12,
          letterSpacing: 0,
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        {label}
      </span>
    );
  }
  const repo = label.slice(0, separatorIndex);
  const title = label.slice(separatorIndex + separator.length);
  return (
    <span
      title={label}
      style={{
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 12,
        fontFamily: 'var(--font-sans-system)',
        letterSpacing: 0,
      }}
    >
      <span style={{ color: 'var(--t-text)', fontWeight: 500 }}>{repo}</span>
      <span style={{ color: 'var(--t-text-faint)', fontWeight: 400 }}> / </span>
      <span style={{ color: 'var(--t-text-secondary)', fontWeight: 400 }}>{title}</span>
    </span>
  );
}
