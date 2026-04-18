'use client';

import { memo, useCallback } from 'react';
import { FileText } from './lucide-shims';
import { CommandStripNode } from '@/components/desktop/CommandStripNode';
import { CompactionNode } from '@/components/desktop/CompactionNode';
import { ThinkingStrip } from '@/components/desktop/orchestrator/ThinkingStrip';
import type {
  MobileTranscriptEntry,
  MobileTranscriptMedia,
} from '@/lib/mobile/types';
import { DesktopToolCallStack } from '@/components/desktop/DesktopToolCallStack';
import { renderLLMMarkdown } from './LLMMarkdown';
import { MessageActions } from './MessageActions';
import { usePretextHeight } from '@/lib/pretext';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';

interface DesktopAgentMessageProps {
  entry: MobileTranscriptEntry;
  isLast?: boolean;
  repoPath?: string | null;
  onApplyToFile?: (code: string, language: string) => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
}

function mediaHref(path: string) {
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
    return path;
  }
  return `/api/mobile/media?path=${encodeURIComponent(path)}`;
}

function isImageMedia(item: MobileTranscriptMedia) {
  return item.kind === 'image';
}

function MediaGrid({
  media,
  tint,
}: {
  media: MobileTranscriptMedia[];
  tint: 'user' | 'assistant';
}) {
  const images = media.filter(isImageMedia);
  const files = media.filter((item) => !isImageMedia(item));

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      width: '100%',
      maxWidth: tint === 'user' ? '82%' : '92%',
    }}>
      {images.length > 0 ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: images.length === 1 ? '1fr' : '1fr 1fr',
          gap: 8,
        }}>
          {images.map((item, index) => (
            <a
              key={`${item.path}-${index}`}
              href={mediaHref(item.path)}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'block',
                overflow: 'hidden',
                borderRadius: 14,
                border: tint === 'user' ? '1px solid rgba(255,255,255,0.18)' : '1px solid var(--t-divider)',
                background: tint === 'user' ? 'rgba(255,255,255,0.10)' : 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
                boxShadow: tint === 'user' ? 'none' : 'var(--t-panel-shadow)',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={mediaHref(item.path)}
                alt={item.name}
                loading="lazy"
                style={{
                  display: 'block',
                  width: '100%',
                  maxHeight: images.length === 1 ? 280 : 180,
                  objectFit: 'cover',
                }}
              />
            </a>
          ))}
        </div>
      ) : null}

      {files.map((item, index) => (
        <div
          key={`${item.path}-${index}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderRadius: 12,
            border: tint === 'user' ? '1px solid rgba(255,255,255,0.18)' : '1px solid var(--t-divider)',
            background: tint === 'user' ? 'rgba(255,255,255,0.10)' : 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
            color: tint === 'user' ? '#ffffff' : 'var(--t-text)',
          }}
        >
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 10,
            background: tint === 'user' ? 'rgba(255,255,255,0.14)' : 'var(--t-accent-soft)',
            color: tint === 'user' ? '#ffffff' : 'var(--t-accent)',
            flexShrink: 0,
          }}>
            <FileText size={16} strokeWidth={2} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {item.name}
            </div>
            <div style={{
              fontSize: 10,
              color: tint === 'user' ? 'rgba(255,255,255,0.78)' : 'var(--t-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {item.kind}
            </div>
          </div>
          <a
            href={mediaHref(item.path)}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: tint === 'user' ? '#ffffff' : 'var(--t-accent)',
              textDecoration: 'none',
            }}
          >
            Open
          </a>
        </div>
      ))}
    </div>
  );
}

export const DesktopAgentMessage = memo(function DesktopAgentMessage({
  entry,
  isLast = false,
  repoPath,
  onApplyToFile,
  onOpenInCanvas,
  onRunInTerminal,
}: DesktopAgentMessageProps) {
  const isUser = entry.role === 'user';
  const displayText = sanitizeTranscriptText(entry.text);
  const hasText = Boolean(displayText.trim());
  const hasMedia = Boolean(entry.media?.length);
  const hasToolCalls = Boolean(entry.toolCalls?.length);
  const isCompaction = entry.type === 'compaction'
    || (entry.role === 'system' && entry.text.toLowerCase().includes('compaction'));

  // Pretext: pre-calculate user message height (plain text, pre-wrap).
  // The orchestrator chat tile is render-hot during streaming — avoiding
  // reflows on every token matters. Width ~100% of panel minus padding
  // (16px × 2 + 12px × 2 = 56px).
  const userTextHeight = usePretextHeight(
    isUser ? displayText : '',
    'small', // 13px matches user bubble fontSize
    340 - 32, // approximate max-width minus padding
    1.55,
    'pre-wrap',
  );

  const handleApplyDiff = useCallback(async (diffText: string) => {
    const trimmedRepoPath = repoPath?.trim();
    if (!trimmedRepoPath) {
      console.error('[diff-card] Failed to apply diff:', new Error('No active repository selected.'));
      return;
    }

    try {
      const response = await fetch('/api/lanes/apply-diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diffText, repoPath: trimmedRepoPath }),
      });
      const result = await response.json().catch(() => null) as { laneId?: string; error?: string; note?: string } | null;
      if (!response.ok || !result?.laneId) {
        throw new Error(result?.error || result?.note || 'Apply failed');
      }
      window.dispatchEvent(new CustomEvent('o8:lane-lifecycle'));
    } catch (error) {
      console.error('[diff-card] Failed to apply diff:', error);
    }
  }, [repoPath]);

  if (isCompaction) {
    return (
      <CompactionNode
        summary={entry.compaction?.summary}
        trigger={entry.compaction?.trigger}
        tokensBefore={entry.compaction?.tokensBefore}
        tokensAfter={entry.compaction?.tokensAfter}
        timestampLabel={entry.timestampLabel}
      />
    );
  }

  if (entry.type === 'command' && entry.command) {
    return <CommandStripNode command={entry.command} timestampLabel={entry.timestampLabel} />;
  }

  if (isUser) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 8,
      }}>
        {hasMedia ? <MediaGrid media={entry.media ?? []} tint="user" /> : null}
        {hasText ? (
          <div style={{
            maxWidth: '85%',
            padding: '8px 14px',
            borderRadius: '14px 14px 4px 14px',
            background: 'rgba(99, 138, 255, 0.13)',
            color: 'var(--t-text)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 13,
            fontWeight: 380,
            lineHeight: 1.5,
            letterSpacing: '-0.005em',
            // Pretext: explicit minHeight eliminates reflow in z-9999 stacking context
            ...(userTextHeight > 0 ? { minHeight: userTextHeight } : {}),
          }}>
            {displayText}
          </div>
        ) : null}
        {entry.timestampLabel ? (
          <span style={{
            fontSize: 10,
            color: 'var(--t-text-faint)',
            paddingRight: 4,
          }}>
            {entry.timestampLabel}
          </span>
        ) : null}
      </div>
    );
  }

  const hasThinking = Boolean(entry.thinking?.trim());
  const thinkingLive = (
    !displayText.trim()
    || entry.toolCalls?.some((toolCall) => toolCall.status === 'running' || toolCall.status === 'calling')
  );

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 8,
      animation: isLast ? 'llmFadeIn 180ms ease-out' : undefined,
    }}>
      {hasThinking ? (
        <ThinkingStrip
          thinking={sanitizeTranscriptText(entry.thinking!)}
          live={thinkingLive}
          style={{ maxWidth: '100%' }}
        />
      ) : null}

      {hasText ? (
        <div style={{
          maxWidth: '100%',
          color: entry.role === 'system' ? 'var(--t-text-secondary)' : 'var(--t-text)',
          fontSize: 13,
          fontWeight: 360,
          lineHeight: 1.6,
          letterSpacing: '-0.005em',
          wordBreak: 'break-word',
          padding: entry.role === 'system' ? '10px 12px' : 0,
          borderRadius: entry.role === 'system' ? 12 : 0,
          background: entry.role === 'system' ? 'var(--t-bg-card, rgba(148, 163, 184, 0.06))' : 'transparent',
          border: entry.role === 'system' ? '1px solid var(--t-divider)' : 'none',
          boxShadow: entry.role === 'system' ? 'var(--t-panel-shadow)' : 'none',
        }}>
          {renderLLMMarkdown(displayText, {
            onApplyToFile,
            onApplyDiff: repoPath ? handleApplyDiff : undefined,
            onOpenInCanvas,
            onRunInTerminal,
          })}
        </div>
      ) : null}

      {hasMedia ? <MediaGrid media={entry.media ?? []} tint="assistant" /> : null}
      {hasToolCalls ? <DesktopToolCallStack toolCalls={entry.toolCalls ?? []} /> : null}

      {entry.role === 'assistant' && hasText ? (
        <div style={{ width: '100%' }}>
          <MessageActions messageId={entry.id} messageText={displayText} />
        </div>
      ) : null}

      {entry.timestampLabel ? (
        <span style={{
          fontSize: 10,
          color: 'var(--t-text-faint)',
          paddingLeft: 2,
        }}>
          {entry.timestampLabel}
        </span>
      ) : null}
    </div>
  );
});
