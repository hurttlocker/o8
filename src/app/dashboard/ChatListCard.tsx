'use client';

import type { ReactNode } from 'react';
import { workspaceFrameCorners } from '@/components/desktop/shell/shell-geometry';
import { DashboardFrame } from './DashboardFrame';

/** Keep the sidebar card's geometry and ink scope in the same presentation. */
export function ChatListCard({ glass, joined, overlay, children }: {
  glass: boolean;
  joined: boolean;
  overlay: boolean;
  children?: ReactNode;
}) {
  return <DashboardFrame
    // Overlay ink follows its own backing, rather than native chrome's white ink.
    data-chrome-surface={overlay ? undefined : 'true'}
    corners={workspaceFrameCorners(joined, true, overlay)}
    autoEffects={false}
    style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: glass ? 'var(--t-bg)' : 'var(--t-sidebar-bg, var(--t-panel-solid))',
    }}
  >{children}</DashboardFrame>;
}
