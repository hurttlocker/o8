'use client';

import { useRef, type ReactNode } from 'react';
import { useSmoothCorners } from '@lisse/react';
import { WORKSPACE_RAIL_CORNER_RADIUS, WORKSPACE_RAIL_CORNER_SMOOTHING } from '../branch-rail-geometry';

export const SESSION_PANE_INSET = 8;

/** Explicit flex wrapper keeps the border overlay from collapsing the chat's height. */
export function SessionPaneFrame({ children }: { children: ReactNode }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  useSmoothCorners(surface, { radius: WORKSPACE_RAIL_CORNER_RADIUS - SESSION_PANE_INSET,
    smoothing: WORKSPACE_RAIL_CORNER_SMOOTHING }, {
    wrapperRef: wrapper, autoEffects: false, effects: { innerBorder: { width: 1, color: 'var(--t-border)', opacity: 1 } },
  });
  return <div ref={wrapper} data-session-pane-frame style={{ position: 'relative', flex: 1,
    display: 'flex', minWidth: 0, minHeight: 0 }}>
    <div ref={surface} style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--t-chat-surface-bg, var(--t-panel))', overflow: 'hidden' }}>
      {children}
    </div>
  </div>;
}
