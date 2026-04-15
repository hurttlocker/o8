'use client';

import { forwardRef } from 'react';
import { DesktopAgentMessage } from '../../DesktopAgentMessage';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

interface ChatMessageListProps {
  displayMessages: MobileTranscriptEntry[];
  displayWaiting: boolean;
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
}

export const ChatMessageList = forwardRef<HTMLDivElement, ChatMessageListProps>(function ChatMessageList({
  displayMessages,
  displayWaiting,
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
}, chatEndRef) {
  const showEmptyWithOverride = displayMessages.length === 0 && !displayWaiting && emptyStateOverride;
  const showEmptyWithFallback = displayMessages.length === 0 && !displayWaiting && !emptyStateOverride;
  const isCompacting = displayWaiting && displayMessages.length > 0 &&
    displayMessages[displayMessages.length - 1]?.text?.toLowerCase().includes('compact');

  return (
    <div className="thoughts-scroll" style={{
      flex: 1,
      overflowY: 'auto',
      padding: '14px 16px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 18,
      background: thoughtsBodyBackground,
      minHeight: 0,
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

      {displayMessages.map((msg, index) => (
        <DesktopAgentMessage
          key={msg.id}
          entry={msg}
          isLast={index === displayMessages.length - 1 && !displayWaiting}
        />
      ))}

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
  );
});
