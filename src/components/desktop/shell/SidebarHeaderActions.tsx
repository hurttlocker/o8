'use client';

import { useRef } from 'react';
import { HeaderIconPill } from './HeaderIconPill';
import { setSidebarView, useSidebarAttention, useSidebarView } from '../repo-focus/tabs/chats/sidebar-view-store';
import type { ChatGroupMode } from '../repo-focus/tabs/chats/sidebar-view';

export function SidebarHeaderActions({ onSearch }: { onSearch?: () => void }) {
  const view = useSidebarView();
  const attention = useSidebarAttention();
  const previous = useRef<ChatGroupMode>('chronological');
  const priority = view === 'flat';
  return <>
    <HeaderIconPill label="Priority chats" pressed={priority} yNudge={0} onClick={() => {
      if (!priority) previous.current = view;
      setSidebarView(priority ? previous.current : 'flat');
    }} icon={<span style={{ position: 'relative', display: 'flex', color: priority ? 'var(--t-accent)' : undefined }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      </svg>
      {attention ? <span data-attention-dot aria-hidden="true" style={{ position: 'absolute', right: -1, top: -2, width: 5, height: 5, borderRadius: '50%', background: 'var(--t-accent)' }} /> : null}
    </span>} title={attention ? 'Priority chats — needs attention' : 'Priority chats'} />
    {onSearch ? <HeaderIconPill label="Search chats" yNudge={0} onClick={onSearch} icon={
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
    } /> : null}
  </>;
}
