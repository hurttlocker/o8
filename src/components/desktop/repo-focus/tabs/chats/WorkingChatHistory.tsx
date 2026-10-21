'use client';

import type { ReactNode } from 'react';
import type { SidebarFixture } from '@/lib/ui/sidebar-fixtures';
import { ChatGroupPicker } from './ChatGroupPicker';
import { attentionRank } from './sections';
import { ChatHistoryShelf } from './ChatHistoryShelf';
import { SidebarDemoStates, sidebarFixtureAttention } from './SidebarDemoStates';
import type { ChatGroupMode } from './sidebar-view';
import { usePublishSidebarAttention } from './sidebar-view-store';
import type { ChatHistoryItem, ChatsTabProps } from './types';
import type { ChatViewAction } from './sidebar-agent-navigation';

/** Keep pinned conversations anchored while active work and quiet history fold independently. */
export function WorkingChatHistory({ items, workingIds, fixtures, activeSessionKey, renderHistoryRow,
  onOpenHistoryChat, onChangeView, showAll, onShowMore, viewActions }: {
  items: ChatHistoryItem[];
  workingIds: ReadonlySet<string>;
  fixtures: SidebarFixture[];
  activeSessionKey?: string | null;
  renderHistoryRow: (item: ChatHistoryItem) => ReactNode;
  onOpenHistoryChat: ChatsTabProps['onOpenHistoryChat'];
  onChangeView: (mode: ChatGroupMode) => void;
  showAll: boolean;
  onShowMore: () => void;
  viewActions?: readonly ChatViewAction[];
}) {
  const pinned = items.filter(item => item.pinned);
  const working = items.filter(item => !item.pinned && workingIds.has(item.tabId));
  const settled = items.filter(item => !item.pinned && !workingIds.has(item.tabId));
  usePublishSidebarAttention(fixtures.filter(sample => attentionRank(sidebarFixtureAttention(sample)) > 0).length);
  const picker = <ChatGroupPicker mode="working" onChange={onChangeView} actions={viewActions} />;
  return <>
    {pinned.length ? <ChatHistoryShelf label="Pinned" action={picker}>
      {pinned.map(renderHistoryRow)}
    </ChatHistoryShelf> : null}
    <ChatHistoryShelf label="Working" action={pinned.length ? undefined : picker}>
        <SidebarDemoStates mode="working" shelf="working" publishAttention={false} fixtures={fixtures}
          activeSessionKey={activeSessionKey} onOpenHistoryChat={onOpenHistoryChat} />
        {working.map(renderHistoryRow)}
    </ChatHistoryShelf>
    <ChatHistoryShelf label="Settled" initiallyCollapsed>
        <SidebarDemoStates mode="working" shelf="settled" publishAttention={false} fixtures={fixtures}
          activeSessionKey={activeSessionKey} onOpenHistoryChat={onOpenHistoryChat} />
        {(showAll ? settled : settled.slice(0, 12)).map(renderHistoryRow)}
        {!showAll && settled.length > 12 ? <button type="button" onClick={onShowMore}
          style={{ borderWidth: 0, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer',
            fontFamily: 'var(--font-sans-system)', fontSize: 10, paddingTop: 6, paddingRight: 12, paddingBottom: 6, paddingLeft: 12 }}>
          Show {settled.length - 12} more
        </button> : null}
    </ChatHistoryShelf>
  </>;
}
