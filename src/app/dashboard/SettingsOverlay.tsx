'use client';

import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

const SETTINGS_OVERLAY_INSET = 8;

export function SettingsOverlay({
  children,
  panelRef,
}: {
  children: ReactNode;
  panelRef: RefObject<HTMLDivElement | null>;
}) {
  // Portal to <body>. This overlay is position:fixed so it can span the FULL
  // app viewport, but `position: fixed` is resolved against the nearest
  // ancestor carrying a transform / filter / clip-path — and the center
  // workspace card it mounts under now has a clip-path (Lisse squircle
  // corners). Without the portal that clip-path traps + clips the panel to
  // the workspace column. Portaling escapes any such ancestor and matches the
  // app's other overlays (createPortal is the house pattern for fixed UI).
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 220,
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
    </div>,
    document.body,
  );
}
