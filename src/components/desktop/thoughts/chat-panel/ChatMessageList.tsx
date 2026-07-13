'use client';

import { Fragment, forwardRef } from 'react';
import { DesktopAgentMessage } from '../../DesktopAgentMessage';
import { SuggestedReplies } from '../SuggestedReplies';
import { TurnSummaryCard, type TurnSummary } from './TurnSummaryCard';
import { CollideProposalCard } from './CollideProposalCard';
import { MissionCompleteGroupCard } from './MissionCompleteGroupCard';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { noteUserScroll } from '@/lib/tts/scroll-follow';

// A run of ≥2 consecutive mission-complete cards collapses into ONE aggregate
// (MissionCompleteGroupCard); everything else renders as its own message. Keys
// on the structured statusEvent, so grouping survives a thread reload.
type MissionRenderItem =
  | { kind: 'msg'; msg: MobileTranscriptEntry; index: number }
  | { kind: 'mission-group'; entries: MobileTranscriptEntry[]; lastIndex: number };

function isPacketTerminalEntry(m: MobileTranscriptEntry): boolean {
  return m.statusEvent?.kind === 'mission-complete' || m.statusEvent?.kind === 'merge';
}

export function buildMissionRenderItems(messages: MobileTranscriptEntry[]): MissionRenderItem[] {
  const items: MissionRenderItem[] = [];
  let i = 0;
  while (i < messages.length) {
    if (isPacketTerminalEntry(messages[i])) {
      let j = i;
      while (j < messages.length && isPacketTerminalEntry(messages[j])) j += 1;
      if (j - i >= 2) {
        items.push({ kind: 'mission-group', entries: messages.slice(i, j), lastIndex: j - 1 });
      } else {
        items.push({ kind: 'msg', msg: messages[i], index: i });
      }
      i = j;
    } else {
      items.push({ kind: 'msg', msg: messages[i], index: i });
      i += 1;
    }
  }
  return items;
}

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
  /** Rendered at the live edge of the transcript — after the last message,
   *  before the thinking indicator. Used for the inline swarm crew card. */
  bottomContent?: React.ReactNode;
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
  bottomContent,
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
    <div
      className="thoughts-scroll cortex-scroll-fade-y cortex-themed-scroll"
      // Voice-playback scroll-follow yields to a manual scroll gesture here.
      onWheel={noteUserScroll}
      onTouchMove={noteUserScroll}
      style={{
      flex: 1,
      overflowY: 'auto',
      paddingTop: 14,
      paddingRight: 'var(--cortex-chat-gutter)',
      // Breathing room before the composer, sized to CLEAR the 30px bottom-fade
      // mask below — so scrolled all the way down, the last item (e.g. the
      // Mission complete card) sits fully in the sharp region above the fade and
      // never dissolves; only the empty padding fades into the composer.
      paddingBottom: 36,
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

        {buildMissionRenderItems(displayMessages).map((item) => {
          if (item.kind === 'mission-group') {
            const isLastGroup = item.lastIndex === displayMessages.length - 1 && !displayWaiting;
            return (
              <MissionCompleteGroupCard
                key={`mission-group-${item.entries[0].id}`}
                entries={item.entries.map((e) => ({ key: e.id, event: e.statusEvent!, timestampLabel: e.timestampLabel }))}
                isLast={isLastGroup}
              />
            );
          }
          const { msg, index } = item;
          const isLatestAssistant = index === lastAssistantIndex;
          const showChipsHere = isLatestAssistant
            && hasSuggestedReplies
            && msg.id === suggestedReplyMessageId
            && onSelectSuggestion
            && onDismissSuggestions;
          // Collide pre-roll — render the faint proposals card instead of the
          // default message body (the entry carries no assistant text of its own).
          if (msg.collide) {
            return (
              <Fragment key={msg.id}>
                <CollideProposalCard collide={msg.collide} />
              </Fragment>
            );
          }
          // The "Worked for Ns" line anchors ABOVE the turn's FIRST assistant
          // message (Cursor position — right under the operator prompt).
          // Legacy summaries without the first-message anchor fall back to the
          // old after-last position so restored threads don't lose the line.
          const summaryAnchorsBefore = turnSummary?.firstAssistantMessageId
            ? msg.id === turnSummary.firstAssistantMessageId
            : false;
          const summaryAnchorsAfter = turnSummary && !turnSummary.firstAssistantMessageId
            ? msg.id === turnSummary.assistantMessageId
            : false;
          return (
            <Fragment key={msg.id}>
              {summaryAnchorsBefore && turnSummary ? (
                <TurnSummaryCard summary={turnSummary} />
              ) : null}
              <DesktopAgentMessage
                entry={msg}
                isLast={index === displayMessages.length - 1 && !displayWaiting}
                isStreaming={isLatestAssistant && !!displayWaiting}
                repoPath={repoPath}
              />
              {summaryAnchorsAfter && turnSummary ? (
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

        {bottomContent}

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
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 400, color: '#b45309', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
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
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--t-text-secondary)', letterSpacing: '-0.1px' }}>
              {activeTargetLabel} is thinking…
            </span>
          </div>
        ) : null}

        <div ref={chatEndRef} />
      </div>
    </div>
  );
});
