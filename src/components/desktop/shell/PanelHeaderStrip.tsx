'use client';

/**
 * PanelHeaderStrip — header strip for the right (O8 / Review) panel column.
 * Hosts the O8 tab bar plus the browser and right-panel-morph controls.
 * Part of epic #1089.
 */

import type { ReactNode } from 'react';
import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { O8HeaderTabs } from '../o8-panel/O8HeaderTabs';
import { canonicalPanelTab, isRightUtilityTab, type O8Tab } from '../o8-panel/types';
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
  /** Browser pages and utility tabs share the column's top header. */
  panelTabsSlotRef?: (node: HTMLElement | null) => void;
  showBrowserTabs?: boolean;
  prTabsSlot?: ReactNode;
  maximized?: boolean;
  onToggleMaximized?: () => void;
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
  panelTabsSlotRef,
  showBrowserTabs = false,
  prTabsSlot,
  maximized = false,
  onToggleMaximized,
}: PanelHeaderStripProps) {
  const showUtilityTabs = !splitEnabled && (o8ActiveTab === 'launcher' || (isRightUtilityTab(canonicalPanelTab(o8ActiveTab)) && o8ActiveTab !== 'browser'));
  const showTabs = panelTabsSlotRef !== undefined && (showBrowserTabs || showUtilityTabs);
  return (
    <ColumnHeaderStrip
      drag
      center={onO8TabChange ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}>
          {prTabsSlot}
          {panelTabsSlotRef ? <div ref={panelTabsSlotRef} data-no-drag style={{ display: showTabs ? 'flex' : 'none', alignItems: 'center', gap: 1, minWidth: 0, flex: 1, overflow: 'hidden', ['WebkitAppRegion' as string]: 'no-drag' }} /> : null}
          {!showTabs || o8ActiveTab === 'browser' ? <HeaderIconPill label="Open right panel tab picker" onClick={() => onO8TabChange('launcher')} icon={<svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>} /> : null}
          <O8HeaderTabs activeTab={o8ActiveTab} onTabChange={onO8TabChange} opener more onNewPage={() => { onO8TabChange('browser'); window.dispatchEvent(new CustomEvent('o8:browser-new-page')); }} />
        </div>
      ) : null}
      right={
        <>
          {onOpenInbox ? (
            <ApprovalInboxBadge count={approvalCount} onClick={onOpenInbox} />
          ) : null}
          {onToggleMaximized ? <HeaderIconPill
            onClick={onToggleMaximized}
            label={maximized ? 'Restore panel size' : 'Maximize panel'}
            title={maximized ? 'Restore panel size · Esc' : 'Maximize panel'}
            pressed={maximized}
            yNudge={-3}
            icon={<svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{maximized ? <><path d="M14 3v7h7M3 14h7v7M21 3l-7 7M3 21l7-7" /></> : <><path d="M14 3h7v7M3 14v7h7M21 3l-7 7M3 21l7-7" /></>}</svg>}
          /> : null}
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
