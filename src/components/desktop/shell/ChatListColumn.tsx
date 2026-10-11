'use client';

import type { CSSProperties, ReactNode } from 'react';

export const NAVIGATION_RAIL_WIDTH = 68;

/** Keep the list instance and scroll containers alive while its column is closed. */
export function ChatListColumn({ visible, width, overlay, onClose, children }: {
  visible: boolean;
  width: number;
  overlay: boolean;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <aside
      id="o8-chat-list"
      aria-label="Chats and workers"
      aria-hidden={!visible}
      inert={!visible}
      data-o8-chat-list="true"
      data-mcp-scope="agent-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if ((event.target as Element).closest('[role="menu"], [role="dialog"]')) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      style={{
        display: visible ? 'flex' : 'none',
        flexDirection: 'column',
        flexShrink: 0,
        width,
        maxWidth: overlay
          ? `calc(100vw / var(--ui-zoom, 1) - ${NAVIGATION_RAIL_WIDTH + 12}px)`
          : `max(160px, calc(100vw / var(--ui-zoom, 1) - ${NAVIGATION_RAIL_WIDTH + 492}px))`,
        height: '100%',
        minHeight: 0,
        position: overlay ? 'absolute' : 'relative',
        left: overlay ? NAVIGATION_RAIL_WIDTH : undefined,
        zIndex: overlay ? 180 : undefined,
      } as CSSProperties}
    >
      {children}
    </aside>
  );
}
