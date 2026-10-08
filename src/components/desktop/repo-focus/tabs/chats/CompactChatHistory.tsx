import type { ReactNode } from 'react';
import type { RepoFocusRepo } from '../../types';
import { canCreateOrchestratorForRepo } from '../../../agent-panel-repo-selection';
import { ChatGroupPicker } from './ChatGroupPicker';
import { CHAT_VIEW_LABELS, type ChatGroupMode } from './sidebar-view';
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
  const pinned = remainder.filter((item) => item.pinned);
  const conversations = remainder.filter((item) => !item.pinned);
  return (
    <>
      <SectionLabel label="Chats" compact action={
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingRight: 3 }}>
          <span style={{ fontSize: 9.5, fontWeight: 260 }}>{CHAT_VIEW_LABELS[chatGroupBy]}</span>
          <ChatGroupPicker mode={chatGroupBy} onChange={updateChatGroupBy} />
        </div>
      } />
      {chatGroupBy === 'flat' || chatGroupBy === 'working' ? (
        <>
          {priority.length > 0 ? <RepoGroupLabel label="Priority" noIcon /> : null}
          {priority.length > 0 ? (
            priority.map((item) => renderHistoryRow(item))
          ) : (
            <div
              style={{
                paddingTop: 3,
                paddingRight: 12,
                paddingBottom: 5,
                paddingLeft: 12,
                color: 'var(--t-text-faint)',
                fontSize: 9.5,
                lineHeight: 1.25,
                fontWeight: 260,
                letterSpacing: '-0.4px',
              }}
            >
              Nothing needs attention
            </div>
          )}
          {pinned.length > 0 ? <><RepoGroupLabel label="Pinned" noIcon />{pinned.map(renderHistoryRow)}</> : null}
          {conversations.length > 0 ? <RepoGroupLabel label={chatGroupBy === 'working' ? 'Working' : 'Conversations'} noIcon /> : null}
          {conversations.map(renderHistoryRow)}
        </>
      ) : chatGroupBy === 'chronological' ? (
        flatHistoryItems.map(renderHistoryRow)
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
