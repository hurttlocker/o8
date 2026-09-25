'use client';

import { useRef } from 'react';
import type React from 'react';
import { O8HeaderTabs } from './O8HeaderTabs';
import type { O8Tab } from './types';

const DIVIDER_HEIGHT = 36;

export function panelPaneVisible(tab: O8Tab, primary: O8Tab, secondary: O8Tab | null): boolean {
  const matches = (selected: O8Tab | null) => selected === tab || (tab === 'activity' && selected === 'prs');
  return matches(primary) || matches(secondary);
}

export function panelPaneStyle(tab: O8Tab, primary: O8Tab, secondary: O8Tab | null, ratio: number): React.CSSProperties {
  const top = tab === primary || (tab === 'activity' && primary === 'prs');
  const visible = panelPaneVisible(tab, primary, secondary);
  if (!secondary) {
    return { display: visible ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden' };
  }
  const share = top ? ratio : 100 - ratio;
  return {
    display: visible ? 'flex' : 'none',
    order: top ? 0 : 2,
    flex: 'none',
    height: `calc(${share}% - ${DIVIDER_HEIGHT * share / 100}px)`,
    minHeight: 0,
    flexDirection: 'column',
    overflow: 'hidden',
  };
}

export function O8PanelSplitDivider({
  secondary,
  ratio,
  onRatioChange,
  onSecondaryChange,
  containerRef,
}: {
  secondary: O8Tab;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  onSecondaryChange: (tab: O8Tab) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const dragging = useRef(false);
  const updateFromPointer = (clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const available = Math.max(1, rect.height - DIVIDER_HEIGHT);
    const next = Math.round(((clientY - rect.top) / available) * 100);
    onRatioChange(Math.max(25, Math.min(75, next)));
  };

  return (
    <div style={{ order: 1, height: DIVIDER_HEIGHT, flexShrink: 0, borderTop: '1px solid var(--t-divider)', background: 'var(--t-chrome)' }}>
      <div
        role="separator"
        aria-label="Resize right panel views"
        aria-orientation="horizontal"
        aria-valuemin={25}
        aria-valuemax={75}
        aria-valuenow={ratio}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromPointer(event.clientY);
        }}
        onPointerMove={(event) => { if (dragging.current) updateFromPointer(event.clientY); }}
        onPointerUp={(event) => {
          dragging.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { dragging.current = false; }}
        onDoubleClick={() => onRatioChange(50)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            onRatioChange(Math.max(25, Math.min(75, ratio + (event.key === 'ArrowDown' ? 5 : -5))));
          }
          if (event.key === 'Home') { event.preventDefault(); onRatioChange(25); }
          if (event.key === 'End') { event.preventDefault(); onRatioChange(75); }
        }}
        style={{ height: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'row-resize', touchAction: 'none' }}
      >
        <span aria-hidden style={{ width: 30, height: 2, borderRadius: 2, background: 'var(--t-drag-handle)' }} />
      </div>
      <div style={{ height: 28, display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 8, paddingRight: 8 }}>
        <O8HeaderTabs activeTab={secondary} onTabChange={onSecondaryChange} ariaLabelPrefix="Lower panel view" />
      </div>
    </div>
  );
}
