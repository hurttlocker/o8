import type { ReactNode } from 'react';
import type { RepoFocusRepo } from '../../types';
import { canCreateOrchestratorForRepo } from '../../../agent-panel-repo-selection';
import { ChatGroupPicker } from './ChatGroupPicker';
import type { ChatGroupMode } from './sidebar-view';
import { CONVERSATIONS_GROUP_KEY } from './helpers';
import { MissingRepoRailNotice } from './MissingRepoRailNotice';
import { RepoGroupLabel, SectionLabel } from './shared';
import { REPO_FOCUS_FONT } from '../../utils';
import type { ChatHistoryItem, RepoHistoryGroup } from './types';

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
}
export function CompactChatHistory({ chatGroupBy, updateChatGroupBy, priority, remainder,
  flatHistoryItems, flatHistoryDateGroups, flatHistoryRepoGroups, collapsedRepoGroups,
  repoByGroupKey, toggleRepoGroup, onCreateOrchestratorForRepo, renderHistoryRow,
  hiddenChatCount, showMore }: Props) {
  const normal = chatGroupBy === 'chronological';
  const source = normal ? flatHistoryItems : remainder;
  const heading = (chatGroupBy === 'flat' || chatGroupBy === 'working') && priority.length > 0 ? 'Priority' : source.some((item) => item.pinned) ? 'Pinned' : 'Recents';
  const pinned = source.filter((item) => item.pinned);
  const conversations = source.filter((item) => !item.pinned);
  return (
    <>
      <SectionLabel label={heading} compact action={
        <ChatGroupPicker mode={chatGroupBy} onChange={updateChatGroupBy} />
      } />
      {chatGroupBy === 'flat' || chatGroupBy === 'working' ? (
        <>
          {priority.map(renderHistoryRow)}
          {pinned.length > 0 ? <>{heading !== 'Pinned' ? <RepoGroupLabel label="Pinned" noIcon /> : null}{pinned.map(renderHistoryRow)}</> : null}
          {conversations.length > 0 && heading !== 'Recents' ? <RepoGroupLabel label={chatGroupBy === 'working' ? 'Working' : 'Recents'} noIcon /> : null}
          {conversations.map(renderHistoryRow)}
        </>
      ) : chatGroupBy === 'chronological' ? (
        <>
          {flatHistoryItems.filter((item) => item.pinned).map(renderHistoryRow)}
          {pinned.length > 0 && conversations.length > 0 ? <RepoGroupLabel label="Recents" noIcon /> : null}
          {flatHistoryItems.filter((item) => !item.pinned).map(renderHistoryRow)}
        </>
      ) : chatGroupBy === 'date' ? (
        flatHistoryDateGroups.map((group) => (
          <div key={group.key}>
            <RepoGroupLabel
              label={group.label}
            />
            {group.items.map((item) => renderHistoryRow(item))}
          </div>
        ))
      ) : (
        flatHistoryRepoGroups.map((group) => {
          const isConversations = group.key === CONVERSATIONS_GROUP_KEY;
          const groupCollapsed = collapsedRepoGroups.has(group.key);
          const groupRepo = isConversations ? undefined : repoByGroupKey.get(group.key);
          const groupRepoMissing = groupRepo?.readiness?.state === 'missing';
          return (
            <div key={group.key}>
              <RepoGroupLabel
                label={group.label}
                noIcon={isConversations}
                collapsed={groupCollapsed}
                onToggle={() => toggleRepoGroup(group.key)}
                onCreate={canCreateOrchestratorForRepo(groupRepo) && onCreateOrchestratorForRepo
                  ? () => onCreateOrchestratorForRepo(groupRepo)
                  : undefined}
                createTitle={groupRepo ? `New session in ${groupRepo.name}` : undefined}
              />
              {groupRepoMissing ? <MissingRepoRailNotice summary={groupRepo.readiness?.summary ?? ''} /> : null}
              {groupCollapsed ? null : group.items.map((item) => renderHistoryRow(item))}
            </div>
          );
        })
      )}
      {hiddenChatCount > 0 ? (
        <button
          type="button"
          onClick={showMore}
          style={{
            width: '100%',
            minHeight: 25,
            borderWidth: 0,
            background: 'transparent',
            color: 'var(--t-text-faint)',
            cursor: 'pointer',
            paddingTop: 4,
            paddingRight: 12,
            paddingBottom: 4,
            paddingLeft: 37,
            textAlign: 'left',
            fontFamily: REPO_FOCUS_FONT,
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
          }}
        >
          Show {hiddenChatCount} more
        </button>
      ) : null}
    </>
  );
}
