'use client';

import type { ReactNode, RefObject } from 'react';

const SETTINGS_OVERLAY_INSET = 8;

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
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 45,
        display: 'flex',
        paddingTop: SETTINGS_OVERLAY_INSET,
        paddingRight: SETTINGS_OVERLAY_INSET,
        paddingBottom: SETTINGS_OVERLAY_INSET,
        paddingLeft: SETTINGS_OVERLAY_INSET,
        boxSizing: 'border-box',
        pointerEvents: 'none',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label="settings panel"
        style={{
          width: '100%',
          height: '100%',
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
