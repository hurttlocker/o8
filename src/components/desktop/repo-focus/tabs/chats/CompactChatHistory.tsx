import { Children, Fragment, type ReactNode } from 'react';
import type { SidebarFixture } from '@/lib/ui/sidebar-fixtures';
import type { RepoFocusRepo } from '../../types';
import { canCreateOrchestratorForRepo } from '../../../agent-panel-repo-selection';
import { ChatGroupPicker } from './ChatGroupPicker';
import { ChatHistoryShelf } from './ChatHistoryShelf';
import { staysInWorkingView, type ChatGroupMode } from './sidebar-view';
import { CONVERSATIONS_GROUP_KEY } from './helpers';
import { MissingRepoRailNotice } from './MissingRepoRailNotice';
import { RepoGroupLabel } from './shared';
import { SidebarDemoStates, sidebarFixtureAttention } from './SidebarDemoStates';
import { attentionRank, deriveHistoryDateGroups } from './sections';
import { usePublishSidebarAttention } from './sidebar-view-store';
import type { ChatHistoryItem, ChatsTabProps, RepoHistoryGroup } from './types';

interface Props {
  chatGroupBy: ChatGroupMode;
  updateChatGroupBy: (mode: ChatGroupMode) => void;
  priority: ChatHistoryItem[];
  remainder: ChatHistoryItem[];
  flatHistoryItems: ChatHistoryItem[];
  flatHistoryDateGroups: Array<{ key: string; label: string; items: ChatHistoryItem[] }>;
  flatHistoryRepoGroups: RepoHistoryGroup[];
  collapsedRepoGroups: Set<string>;
  repoByGroupKey: Map<string, RepoFocusRepo>;
  toggleRepoGroup: (key: string) => void;
  onCreateOrchestratorForRepo?: (repo: RepoFocusRepo) => void;
  renderHistoryRow: (item: ChatHistoryItem) => ReactNode;
  hiddenChatCount: number;
  showMore: () => void;
  fixtures: SidebarFixture[];
  activeSessionKey?: string | null;
  onOpenHistoryChat: ChatsTabProps['onOpenHistoryChat'];
  scheduledSessions?: ReactNode;
}
export function CompactChatHistory({ chatGroupBy, updateChatGroupBy, priority, remainder,
  flatHistoryItems, flatHistoryDateGroups, flatHistoryRepoGroups, collapsedRepoGroups,
  repoByGroupKey, toggleRepoGroup, onCreateOrchestratorForRepo, renderHistoryRow,
  hiddenChatCount, showMore, fixtures, activeSessionKey, onOpenHistoryChat, scheduledSessions }: Props) {
  const source = chatGroupBy === 'chronological' ? flatHistoryItems : remainder;
  const pinned = source.filter(item => item.pinned);
  const conversations = source.filter(item => !item.pinned);
  const attentionCount = fixtures.filter(sample => attentionRank(sidebarFixtureAttention(sample)) > 0).length;
  usePublishSidebarAttention(attentionCount);
  const priorityFixtures = fixtures.filter(sample => staysInWorkingView(sidebarFixtureAttention(sample)));
  const settledFixtures = fixtures.filter(sample => !priorityFixtures.includes(sample));
  const hasPriority = chatGroupBy === 'flat' && (priority.length > 0 || priorityFixtures.length > 0);
  const picker = <ChatGroupPicker mode={chatGroupBy} onChange={updateChatGroupBy} />;
  const demos = <SidebarDemoStates mode={chatGroupBy} fixtures={fixtures} publishAttention={false}
    activeSessionKey={activeSessionKey} onOpenHistoryChat={onOpenHistoryChat} />;
  const more = hiddenChatCount > 0 ? <button type="button" onClick={showMore}
    style={{ width: '100%', minHeight: 28, borderWidth: 0, background: 'transparent', color: 'var(--t-text-muted)',
      cursor: 'pointer', paddingTop: 5, paddingRight: 12, paddingBottom: 5, paddingLeft: 32, textAlign: 'left',
      fontFamily: 'var(--font-sans-system)', fontSize: 10 }}>
    Show {hiddenChatCount} more
  </button> : null;
  if (chatGroupBy === 'scheduled') return <ChatHistoryShelf label="Scheduled" action={picker}
    count={flatHistoryItems.length + fixtures.filter(sample => sample.scheduled).length + Children.count(scheduledSessions)}>
    {demos}{flatHistoryItems.map(renderHistoryRow)}{scheduledSessions}{more}
  </ChatHistoryShelf>;
  if (chatGroupBy === 'date' || chatGroupBy === 'repo') return <ChatHistoryShelf label="Recents" action={picker}
    storageKey={`o8:chat-${chatGroupBy}-recents-collapsed`} count={flatHistoryItems.length + fixtures.length}>
    {demos}
    {chatGroupBy === 'date' ? flatHistoryDateGroups.map(group => <ChatHistoryShelf key={group.key}
      label={group.label} count={group.items.length} storageKey={`o8:chat-date-${group.key}-collapsed`}>
      {group.items.map(renderHistoryRow)}
    </ChatHistoryShelf>) : flatHistoryRepoGroups.map(group => {
      const groupCollapsed = collapsedRepoGroups.has(group.key);
      const groupRepo = group.key === CONVERSATIONS_GROUP_KEY ? undefined : repoByGroupKey.get(group.key);
      return <div key={group.key}>
        <RepoGroupLabel label={group.label} noIcon={group.key === CONVERSATIONS_GROUP_KEY}
          collapsed={groupCollapsed} onToggle={() => toggleRepoGroup(group.key)}
          onCreate={canCreateOrchestratorForRepo(groupRepo) && onCreateOrchestratorForRepo
            ? () => onCreateOrchestratorForRepo(groupRepo) : undefined}
          createTitle={groupRepo ? `New session in ${groupRepo.name}` : undefined} />
        {!groupCollapsed ? <>
          {groupRepo?.readiness?.state === 'missing' ? <MissingRepoRailNotice summary={groupRepo.readiness.summary ?? ''} /> : null}
          {group.items.map(renderHistoryRow)}
        </> : null}
      </div>;
    })}{more}
  </ChatHistoryShelf>;
  return <>
    {hasPriority ? <ChatHistoryShelf label="Priority" count={priority.length + priorityFixtures.length} action={picker}>
      <SidebarDemoStates mode={chatGroupBy} fixtures={priorityFixtures} publishAttention={false}
        activeSessionKey={activeSessionKey} onOpenHistoryChat={onOpenHistoryChat} />{priority.map(renderHistoryRow)}
    </ChatHistoryShelf> : null}
    {pinned.length ? <ChatHistoryShelf label="Pinned" count={pinned.length} action={hasPriority ? undefined : picker}>
      {pinned.map(renderHistoryRow)}
    </ChatHistoryShelf> : null}
    {chatGroupBy === 'flat' ? <>
      {deriveHistoryDateGroups<{ modifiedAt: string; item?: ChatHistoryItem; sample?: SidebarFixture }>([
        ...conversations.map(item => ({ item, modifiedAt: item.modifiedAt })),
        ...settledFixtures.map(sample => ({ sample, modifiedAt: sample.updatedAt })),
      ].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))).map((group, index) => <ChatHistoryShelf key={group.key}
        label={group.label} count={group.items.length} storageKey={`o8:chat-priority-${group.key}-collapsed`}
        action={!hasPriority && !pinned.length && index === 0 ? picker : undefined}>
        {group.items.map(entry => entry.item ? <Fragment key={entry.item.tabId}>{renderHistoryRow(entry.item)}</Fragment>
          : <SidebarDemoStates key={entry.sample!.tabId} mode="flat" fixtures={[entry.sample!]} publishAttention={false}
            showLabel={false} activeSessionKey={activeSessionKey} onOpenHistoryChat={onOpenHistoryChat} />)}
      </ChatHistoryShelf>)}
      {!hasPriority && !pinned.length && !conversations.length && !settledFixtures.length ? <ChatHistoryShelf label="Priority" count={0} action={picker}>{null}</ChatHistoryShelf> : null}
      {more}
    </> : <ChatHistoryShelf label="Recents" count={conversations.length + fixtures.length}
      storageKey={`o8:chat-${chatGroupBy}-recents-collapsed`} action={hasPriority || pinned.length ? undefined : picker}>
      {demos}{conversations.map(renderHistoryRow)}{more}
    </ChatHistoryShelf>}
  </>;
}
