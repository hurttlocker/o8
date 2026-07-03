'use client';

/**
 * PanelHeaderStrip — header strip for the right (O8 / Review) panel column.
 * Hosts the O8 tab bar plus the browser and right-panel-morph controls.
 * Part of epic #1089.
 */

import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { O8HeaderTabs } from '../o8-panel/O8HeaderTabs';
import type { O8Tab } from '../o8-panel/types';
import { ApprovalInboxBadge } from '../title-bar/ApprovalInboxBadge';
import { BrowserHoverButton } from '../title-bar/BrowserHoverButton';
import { RightPanelMorphButton } from '../title-bar/RightPanelMorphButton';

interface PanelHeaderStripProps {
  o8PanelVisible?: boolean;
  workspacePanelVisible?: boolean;
  onToggleO8Panel?: () => void;
  o8ActiveTab?: O8Tab;
  onO8TabChange?: (tab: O8Tab) => void;
  browserActive?: boolean;
  browserPreviewUrl?: string | null;
  onOpenBrowser?: () => void;
  approvalCount?: number;
  onOpenInbox?: () => void;
}

export function PanelHeaderStrip({
  o8PanelVisible = false,
  workspacePanelVisible = false,
  onToggleO8Panel,
  o8ActiveTab = 'workspace',
  onO8TabChange,
  browserActive = false,
  browserPreviewUrl,
  onOpenBrowser,
  approvalCount = 0,
  onOpenInbox,
}: PanelHeaderStripProps) {
  return (
    <ColumnHeaderStrip
      drag
      left={
        onO8TabChange ? (
          <O8HeaderTabs activeTab={o8ActiveTab} onTabChange={onO8TabChange} />
        ) : null
      }
      right={
        <>
          {onOpenInbox ? (
            <ApprovalInboxBadge count={approvalCount} onClick={onOpenInbox} />
          ) : null}
          {onOpenBrowser ? (
            <BrowserHoverButton
              active={browserActive}
              url={browserPreviewUrl ?? null}
              onClick={onOpenBrowser}
            />
          ) : null}
          <RightPanelMorphButton
            workspacePanelVisible={workspacePanelVisible}
            o8PanelVisible={o8PanelVisible}
            onToggleO8Panel={onToggleO8Panel}
          />
        </>
      }
    />
  );
}
