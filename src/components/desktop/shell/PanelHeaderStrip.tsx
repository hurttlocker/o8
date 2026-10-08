'use client';

/**
 * PanelHeaderStrip — header strip for the right (O8 / Review) panel column.
 * Hosts the O8 tab bar plus the browser and right-panel-morph controls.
 * Part of epic #1089.
 */

import type { ReactNode } from 'react';
import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { O8HeaderTabs } from '../o8-panel/O8HeaderTabs';
import type { O8Tab } from '../o8-panel/types';
import { ApprovalInboxBadge } from '../title-bar/ApprovalInboxBadge';
import { RightPanelMorphButton } from '../title-bar/RightPanelMorphButton';
import { HeaderIconPill } from './HeaderIconPill';

interface PanelHeaderStripProps {
  o8PanelVisible?: boolean;
  workspacePanelVisible?: boolean;
  onToggleO8Panel?: () => void;
  o8ActiveTab?: O8Tab;
  onO8TabChange?: (tab: O8Tab) => void;
  splitEnabled?: boolean;
  onToggleSplit?: () => void;
  approvalCount?: number;
  onOpenInbox?: () => void;
  /** Portal target for the browser's page tabs + URL well (Cursor header
   *  borrow, Q 2026-07-12): the browser's whole top chrome renders HERE in
   *  the strip's flex center, walled off from the state drawer by a hairline
   *  divider. The standalone globe button is retired — the drawer's Browser
   *  entry (orange globe when active) is the surface's one handle. */
  browserTabsSlotRef?: (node: HTMLElement | null) => void;
  showBrowserTabs?: boolean;
  prTabsSlot?: ReactNode;
}

export function PanelHeaderStrip({
  o8PanelVisible = false,
  workspacePanelVisible = false,
  onToggleO8Panel,
  o8ActiveTab = 'workspace',
  onO8TabChange,
  splitEnabled = false,
  onToggleSplit,
  approvalCount = 0,
  onOpenInbox,
  browserTabsSlotRef,
  showBrowserTabs = false,
  prTabsSlot,
}: PanelHeaderStripProps) {
  return (
    <ColumnHeaderStrip
      drag
      center={onO8TabChange ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}>
          {prTabsSlot}
          {showBrowserTabs && browserTabsSlotRef ? <div ref={browserTabsSlotRef} data-no-drag style={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flexShrink: 1, overflow: 'hidden', ['WebkitAppRegion' as string]: 'no-drag' }} /> : null}
          <O8HeaderTabs activeTab={o8ActiveTab} onTabChange={onO8TabChange} opener onNewPage={() => { onO8TabChange('browser'); window.dispatchEvent(new CustomEvent('o8:browser-new-page')); }} />

        </div>
      ) : null}
      right={
        <>
          {onOpenInbox ? (
            <ApprovalInboxBadge count={approvalCount} onClick={onOpenInbox} />
          ) : null}
          {onToggleSplit ? (
            <HeaderIconPill
              onClick={onToggleSplit}
              label={splitEnabled ? 'Close right panel split' : 'Split right panel'}
              pressed={splitEnabled}
              title={splitEnabled ? 'Show one panel view' : 'Show two panel views'}
              yNudge={-3}
              icon={
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" focusable="false" style={{ display: 'block', flexShrink: 0 }}>
                  <rect x="3" y="3" width="18" height="18" rx="4" />
                  <path d="M3 12h18" />
                </svg>
              }
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
