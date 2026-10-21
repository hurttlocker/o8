'use client';

import { HeaderIconPill } from './HeaderIconPill';
import { getSidebarReturnView, setSidebarView, useSidebarAttention, useSidebarView } from '../repo-focus/tabs/chats/sidebar-view-store';

export function SidebarHeaderActions({ onSearch, showPriority = true }: { onSearch?: () => void; showPriority?: boolean }) {
  const view = useSidebarView();
  const attention = useSidebarAttention();
  const priority = view === 'flat';
  return <>
    {showPriority ? <HeaderIconPill label="Priority chats" pressed={priority} yNudge={0} onClick={() => {
      setSidebarView(priority ? getSidebarReturnView() : 'flat');
    }} icon={<span style={{ position: 'relative', display: 'flex', color: priority ? 'var(--t-accent)' : undefined }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      </svg>
      {attention ? <span data-attention-dot aria-hidden="true" style={{ position: 'absolute', right: -2, top: -2, width: 7, height: 7, borderRadius: '50%', background: 'var(--t-accent)' }} /> : null}
    </span>} title={attention ? 'Priority chats — unread results or needs attention' : 'Priority chats'} /> : null}
    {onSearch ? <HeaderIconPill label="Search chats" yNudge={0} onClick={onSearch} icon={
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
    } /> : null}
  </>;
}
