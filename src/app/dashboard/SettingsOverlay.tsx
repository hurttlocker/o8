'use client';

import type { ReactNode, RefObject } from 'react';

const SETTINGS_OVERLAY_TOP_OFFSET = 38;

export function SettingsOverlay({
  children,
  panelRef,
}: {
  children: ReactNode;
  panelRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        top: SETTINGS_OVERLAY_TOP_OFFSET,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 45,
        display: 'flex',
        justifyContent: 'center',
        paddingTop: 12,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        boxSizing: 'border-box',
        pointerEvents: 'none',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label="settings panel"
        style={{
          width: 'min(1180px, 100%)',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          overflow: 'hidden',
          borderRadius: 18,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-panel-border)',
          background: 'var(--t-panel-solid, var(--t-panel))',
          boxShadow: 'var(--t-panel-shadow)',
          pointerEvents: 'auto',
        }}
      >
        {children}
      </div>
    </div>
  );
}
