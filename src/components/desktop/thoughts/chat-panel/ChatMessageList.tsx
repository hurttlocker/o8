'use client';

import { Fragment, forwardRef } from 'react';
import { DesktopAgentMessage } from '../../DesktopAgentMessage';
import { SuggestedReplies } from '../SuggestedReplies';
import { TurnSummaryCard, type TurnSummary } from './TurnSummaryCard';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

interface ChatMessageListProps {
  displayMessages: MobileTranscriptEntry[];
  displayWaiting: boolean;
  repoPath?: string | null;
  activeTargetLabel: string;
  activeTargetColor: string;
  thoughtsBodyBackground: string;
  thoughtsMutedGlass: string;
  thoughtsElevatedBorder: string;
  thoughtsElevatedShadow: string;
  emptyStateOverride?: React.ReactNode;
  emptyStateFallback: React.ReactNode;
  topContent?: React.ReactNode;
  // Orchestrator has its own sticky ComposerStatusBar above the textarea
  // that already surfaces "working" state + elapsed time + running tools.
  // Duplicating the inline "is thinking…" bubble here makes the chat feel
  // noisy during tool-heavy turns. CLI lane panels still need the bubble.
  isOrchestratorMode?: boolean;
  // Suggested-reply chips (#771). The parent owns the cache + Gemini fetch and
  // hands us the chip strings for the last assistant message. We render them
  // under that message; click → onSelectSuggestion(text); X → onDismissSuggestions.
  suggestedReplyMessageId?: string | null;
  suggestedReplies?: string[];
  onSelectSuggestion?: (chip: string) => void;
  onDismissSuggestions?: () => void;
  suggestedRepliesCollapsed?: boolean;
  onRestoreSuggestions?: () => void;
  // Phase 4 — when true, render a [•••] placeholder under the last assistant
  // message even if `suggestedReplies` is empty. Indicates a fetch is in
  // flight or just failed, so the user knows chips were attempted.
  suggestedRepliesPending?: boolean;
  // #1095/#1096 — when the orchestrator finishes a turn that touched files or
  // ran tools, the parent passes a TurnSummary anchored to the closing
  // assistant message. The card renders inline directly after that message.
  turnSummary?: TurnSummary | null;
}

export const ChatMessageList = forwardRef<HTMLDivElement, ChatMessageListProps>(function ChatMessageList({
  displayMessages,
  displayWaiting,
  repoPath,
  activeTargetLabel,
  activeTargetColor,
  thoughtsBodyBackground,
  thoughtsMutedGlass,
  thoughtsElevatedBorder,
  thoughtsElevatedShadow,
  emptyStateOverride,
  emptyStateFallback,
  topContent,
  isOrchestratorMode = false,
  suggestedReplyMessageId,
  suggestedReplies,
  onSelectSuggestion,
  onDismissSuggestions,
  suggestedRepliesCollapsed = false,
  onRestoreSuggestions,
  suggestedRepliesPending = false,
  turnSummary = null,
}, chatEndRef) {
  // Phase 4 — chips strip renders when EITHER chips arrived OR a fetch is in
  // flight / just failed (placeholder). Both share the same anchor under the
  // last assistant message. Without the placeholder branch the strip would
  // silently render nothing during transient failures.
  const hasSuggestedReplies = Boolean(
    suggestedReplyMessageId
    && (
      (suggestedReplies && suggestedReplies.length > 0)
      || suggestedRepliesPending
      || (suggestedRepliesCollapsed && onRestoreSuggestions)
    )
    && onSelectSuggestion
    && onDismissSuggestions,
  );
  // #845 — chips must render directly under the assistant message they belong
  // to (not at the list tail). Find the index of the LAST assistant entry; the
  // map below renders the chip row right after that bubble.
  let lastAssistantIndex = -1;
  for (let i = displayMessages.length - 1; i >= 0; i -= 1) {
    if (displayMessages[i]?.role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }
  const showEmptyWithOverride = displayMessages.length === 0 && !displayWaiting && emptyStateOverride;
  const showEmptyWithFallback = displayMessages.length === 0 && !displayWaiting && !emptyStateOverride;
  const isCompacting = displayWaiting && displayMessages.length > 0 &&
    displayMessages[displayMessages.length - 1]?.text?.toLowerCase().includes('compact');

  return (
    <div className="thoughts-scroll cortex-scroll-fade-y cortex-themed-scroll" style={{
      flex: 1,
      overflowY: 'auto',
      paddingTop: 14,
      paddingRight: 'var(--cortex-chat-gutter)',
      paddingBottom: 12,
      paddingLeft: 'var(--cortex-chat-gutter)',
      display: 'flex',
      flexDirection: 'column',
      background: thoughtsBodyBackground,
      minHeight: 0,
    }}>
      <div style={{
        width: '100%',
        maxWidth: 'var(--cortex-chat-column-max)',
        minHeight: '100%',
        marginRight: 'auto',
        marginLeft: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      }}>
        {showEmptyWithOverride ? (
          <div style={{
            display: 'flex',
            flex: 1,
            minHeight: 0,
          }}>
            {emptyStateOverride}
          </div>
        ) : null}
        {showEmptyWithFallback ? emptyStateFallback : null}

        {topContent}

        {displayMessages.map((msg, index) => {
          const isLatestAssistant = index === lastAssistantIndex;
          const showChipsHere = isLatestAssistant
            && hasSuggestedReplies
            && msg.id === suggestedReplyMessageId
            && onSelectSuggestion
            && onDismissSuggestions;
          return (
            <Fragment key={msg.id}>
              <DesktopAgentMessage
                entry={msg}
                isLast={index === displayMessages.length - 1 && !displayWaiting}
                repoPath={repoPath}
              />
              {turnSummary && msg.id === turnSummary.assistantMessageId ? (
                <TurnSummaryCard summary={turnSummary} />
              ) : null}
              {showChipsHere ? (
                <SuggestedReplies
                  chips={suggestedReplies ?? []}
                  disabled={displayWaiting}
                  onSelect={onSelectSuggestion}
                  onDismiss={onDismissSuggestions}
                  collapsed={suggestedRepliesCollapsed}
                  onRestore={onRestoreSuggestions}
                  isPlaceholder={suggestedRepliesPending}
                />
              ) : null}
            </Fragment>
          );
        })}

        {isCompacting ? (
          <div style={{
            padding: '12px 14px',
            borderRadius: 14,
            background: 'linear-gradient(180deg, rgba(254, 249, 195, 0.72), rgba(254, 240, 138, 0.22))',
            border: '1px solid rgba(245, 158, 11, 0.18)',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            boxShadow: '0 12px 30px rgba(245, 158, 11, 0.08)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, color: '#b45309', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(245, 158, 11, 0.3)', borderTopColor: '#f59e0b', animation: 'spin 1s linear infinite' }} />
              Compaction in progress
            </div>
            <div style={{ fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>
              Context is being compressed. Messages sent now will be queued and delivered after compaction completes.
            </div>
          </div>
        ) : null}

        {displayWaiting && !isCompacting && !isOrchestratorMode ? (
          <div style={{
            alignSelf: 'flex-start',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderRadius: 16,
            background: thoughtsMutedGlass,
            border: thoughtsElevatedBorder,
            boxShadow: thoughtsElevatedShadow,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeTargetColor, boxShadow: `0 0 0 4px ${activeTargetColor}14`, flexShrink: 0 }} />
            {[0, 1, 2].map((index) => (
              <div key={index} style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--t-text-secondary)', animation: `llmDot 1.2s ease-in-out ${index * 0.18}s infinite` }} />
            ))}
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)', letterSpacing: '-0.01em' }}>
              {activeTargetLabel} is thinking…
            </span>
          </div>
        ) : null}

        <div ref={chatEndRef} />
      </div>
    </div>
  );
});
