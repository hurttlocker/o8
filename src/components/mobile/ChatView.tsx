'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, FileDiff, FileText, Image as ImageIcon } from 'lucide-react';
import type { MobileTranscriptMedia } from '@/lib/mobile/types';
import type { ChatViewProps } from './types';
import { MediaLightbox } from './MediaLightbox';
import { MessageActions } from './MessageActions';
import {
  formatStreamingPreview,
  isImageMedia,
  mediaHref,
  roleLabel,
} from './utils';

// ── Memoized message bubble — only re-renders when its own data changes ──

interface MessageBubbleProps {
  entry: ChatViewProps['transcriptEntries'][number];
  index: number;
  previousEntry: ChatViewProps['transcriptEntries'][number] | null;
  isLatest: boolean;
  isNewMessage: boolean;
  isOwnedCodexSession: boolean;
  selectedSession: ChatViewProps['selectedSession'];
  selectedReviewFile: ChatViewProps['selectedReviewFile'];
  renderMessageBody: ChatViewProps['renderMessageBody'];
  setExpandedMedia: ChatViewProps['setExpandedMedia'];
  onOpenDiff: ChatViewProps['onOpenDiff'];
  onScrollToLatestMessage: ChatViewProps['onScrollToLatestMessage'];
}

const MessageBubble = memo(function MessageBubble({
  entry,
  index,
  previousEntry,
  isLatest,
  isNewMessage,
  isOwnedCodexSession,
  selectedSession,
  selectedReviewFile,
  renderMessageBody,
  setExpandedMedia,
  onOpenDiff,
  onScrollToLatestMessage,
}: MessageBubbleProps) {
  const isUser = entry.role === 'user';
  const hasText = Boolean(entry.text.trim());
  const hasMedia = Boolean(entry.media?.length);
  const fadeClass = isNewMessage ? ' remodex-turn-new' : '';
  const speakerChanged = !previousEntry || previousEntry.role !== entry.role;
  const showTimestamp = (() => {
    if (!previousEntry?.timestampLabel || !entry.timestampLabel) return speakerChanged;
    const previous = new Date(`1970-01-01 ${previousEntry.timestampLabel}`).getTime();
    const current = new Date(`1970-01-01 ${entry.timestampLabel}`).getTime();
    if (Number.isNaN(previous) || Number.isNaN(current)) return speakerChanged;
    return Math.abs(current - previous) >= 15 * 60 * 1000;
  })();

  if (isUser) {
    return (
      <div className={`remodex-user-turn-wrap${fadeClass}`}>
        {hasText ? <div className="remodex-user-bubble">{renderMessageBody(entry.text, `${entry.id}-user`)}</div> : null}
        {hasMedia ? <MediaGrid media={entry.media ?? []} align="right" setExpandedMedia={setExpandedMedia} onScrollToLatestMessage={onScrollToLatestMessage} /> : null}
        {showTimestamp ? <span className="remodex-turn-time">{entry.timestampLabel ?? 'now'}</span> : null}
      </div>
    );
  }

  const isCompaction = entry.role === 'system' && entry.text.toLowerCase().includes('compaction');
  if (isCompaction) {
    return (
      <div className="remodex-compaction-card">
        <span className="remodex-compaction-icon" aria-hidden="true">⟳</span>
        <span className="remodex-compaction-label">Context compacted</span>
        {showTimestamp ? <span className="remodex-compaction-time">{entry.timestampLabel ?? ''}</span> : null}
      </div>
    );
  }

  const agentName = isOwnedCodexSession ? 'Codex' : (selectedSession?.isCurrentSession ? 'Mister' : undefined);

  return (
    <article className={`remodex-message-card remodex-message-card-assistant${fadeClass}`}>
      {speakerChanged ? (
        <div className="remodex-message-head">
          <span>{roleLabel(entry.role, agentName)}</span>
        </div>
      ) : null}
      {hasText ? renderMessageBody(entry.text, `${entry.id}-assistant`) : null}
      {hasMedia ? <MediaGrid media={entry.media ?? []} align="left" setExpandedMedia={setExpandedMedia} onScrollToLatestMessage={onScrollToLatestMessage} /> : null}
      {isLatest && selectedReviewFile ? (
        <button type="button" className="remodex-inline-diff-thumb" onClick={onOpenDiff}>
          <div className="remodex-inline-diff-mini">
            <FileDiff size={16} strokeWidth={1.8} />
          </div>
          <div className="remodex-inline-diff-copy">
            <strong>{selectedReviewFile.path.split('/').pop() ?? selectedReviewFile.path}</strong>
            <span>{`${selectedReviewFile.additions ?? 0} additions, ${selectedReviewFile.deletions ?? 0} removals`}</span>
          </div>
          <ChevronRight size={16} strokeWidth={1.6} className="remodex-inline-diff-chevron" />
        </button>
      ) : null}
      {hasText ? (
        <MessageActions messageId={entry.id} messageText={entry.text} />
      ) : null}
    </article>
  );
});

// ── Media grid (extracted for memo boundary) ──

function MediaGrid({
  media,
  align,
  setExpandedMedia,
  onScrollToLatestMessage,
}: {
  media: MobileTranscriptMedia[];
  align: 'left' | 'right';
  setExpandedMedia: (media: MobileTranscriptMedia | null) => void;
  onScrollToLatestMessage: () => void;
}) {
  return (
    <div className={`remodex-media-grid ${align === 'right' ? 'remodex-media-grid-right' : ''}`}>
      {media.map((item) => {
        if (isImageMedia(item)) {
          return (
            <button
              key={item.path}
              type="button"
              className="remodex-media-card remodex-media-card-image"
              onClick={() => setExpandedMedia(item)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={mediaHref(item.path)}
                alt={item.name}
                loading="lazy"
                onLoad={() => onScrollToLatestMessage()}
                style={{ width: '100%', height: 'auto', borderRadius: 8, display: 'block' }}
              />
              <span className="remodex-media-card-caption">Tap to expand</span>
            </button>
          );
        }

        return (
          <div key={item.path} className="remodex-media-card remodex-media-card-file">
            <div className="remodex-media-file-icon">
              {item.kind === 'pdf' ? <FileText size={18} strokeWidth={2.1} /> : <ImageIcon size={18} strokeWidth={2.1} />}
            </div>
            <div className="remodex-media-file-copy">
              <strong>{item.name}</strong>
              <span>{item.kind === 'pdf' ? 'PDF artifact' : 'File artifact'}</span>
            </div>
            <div className="remodex-media-file-actions">
              <a href={mediaHref(item.path)} target="_blank" rel="noreferrer">Open</a>
              <a href={mediaHref(item.path, true)} download={item.name}>Save</a>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Virtualized chat view ──

export function ChatView({
  transcriptEntries,
  transcriptLoading,
  isRefreshing,
  composeHeight = 120,
  selectedSession,
  selectedReviewFile,
  streamingText,
  waitingForResponse,
  actionState,
  hydrated,
  isOwnedCodexSession,
  seenMessageIdsRef,
  agentDisplayName,
  renderMessageBody,
  expandedMedia,
  setExpandedMedia,
  onOpenDiff,
  onScrollToLatestMessage,
}: ChatViewProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const prevEntryCountRef = useRef(transcriptEntries.length);

  const getIsNew = useCallback((entryId: string) => {
    return hydrated
      && seenMessageIdsRef.current != null
      && seenMessageIdsRef.current.size > 0
      && !seenMessageIdsRef.current.has(entryId);
  }, [hydrated, seenMessageIdsRef]);

  const markSeen = useCallback((entryId: string) => {
    seenMessageIdsRef.current?.add(entryId);
  }, [seenMessageIdsRef]);

  const estimateSize = useCallback((index: number) => {
    const entry = transcriptEntries[index];
    if (!entry) return 60;
    const textLen = entry.text?.length ?? 0;
    const hasMedia = Boolean(entry.media?.length);
    if (entry.role === 'user') return Math.max(52, 52 + Math.ceil(textLen / 60) * 20 + (hasMedia ? 200 : 0));
    if (entry.role === 'system' && entry.text.toLowerCase().includes('compaction')) return 44;
    return Math.max(64, 64 + Math.ceil(textLen / 50) * 22 + (hasMedia ? 200 : 0));
  }, [transcriptEntries]);

  const virtualizer = useWindowVirtualizer({
    count: transcriptEntries.length,
    estimateSize,
    overscan: 8,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  // No auto-scroll — user controls position via "new messages" button.
  // Only scroll to bottom on initial load (first non-zero entry set).
  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (initialScrollDone.current || transcriptEntries.length === 0) return;
    initialScrollDone.current = true;
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight });
    });
  }, [transcriptEntries.length]);

  // Track scroll position to determine stick-to-bottom + new message pill
  useEffect(() => {
    const handleScroll = () => {
      const distanceFromBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      const atBottom = distanceFromBottom < 120;
      stickToBottomRef.current = atBottom;
      if (atBottom) setHasNewMessages(false);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Detect new assistant messages while scrolled up
  useEffect(() => {
    const prevCount = prevEntryCountRef.current;
    prevEntryCountRef.current = transcriptEntries.length;
    if (transcriptEntries.length > prevCount && !stickToBottomRef.current) {
      const newEntries = transcriptEntries.slice(prevCount);
      if (newEntries.some((e) => e.role === 'assistant')) {
        setHasNewMessages(true);
      }
    }
  }, [transcriptEntries]);

  const hasEntries = transcriptEntries.length > 0;
  const virtualItems = virtualizer.getVirtualItems();

  // Pre-compute once: index of last assistant message (O(1) per item instead of O(n))
  const lastAssistantIndex = useMemo(() => {
    for (let i = transcriptEntries.length - 1; i >= 0; i--) {
      if (transcriptEntries[i].role === 'assistant') return i;
    }
    return -1;
  }, [transcriptEntries]);

  return (
    <>
      <style>{`@keyframes session-fade-in { from { opacity: 0.4; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      <div
        ref={listRef}
        className="remodex-message-stack"
        key={selectedSession?.sessionKey ?? 'none'}
        style={{ animation: 'session-fade-in 0.2s ease-out' }}
      >
        {hasEntries ? (
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {virtualItems.map((virtualRow) => {
              const entry = transcriptEntries[virtualRow.index];
              const previousEntry = virtualRow.index > 0 ? transcriptEntries[virtualRow.index - 1] : null;
              const isLatest = virtualRow.index === lastAssistantIndex;
              const isNew = getIsNew(entry.id);
              if (isNew) markSeen(entry.id);

              return (
                <div
                  key={entry.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start - (virtualizer.options.scrollMargin ?? 0)}px)`,
                  }}
                >
                  <MessageBubble
                    entry={entry}
                    index={virtualRow.index}
                    previousEntry={previousEntry}
                    isLatest={isLatest}
                    isNewMessage={isNew}
                    isOwnedCodexSession={isOwnedCodexSession}
                    selectedSession={selectedSession}
                    selectedReviewFile={selectedReviewFile}
                    renderMessageBody={renderMessageBody}
                    setExpandedMedia={setExpandedMedia}
                    onOpenDiff={onOpenDiff}
                    onScrollToLatestMessage={onScrollToLatestMessage}
                  />
                </div>
              );
            })}
          </div>
        ) : transcriptLoading ? (
          <div className="remodex-skeleton-stack">
            <div className="remodex-skeleton-bubble remodex-skeleton-assistant" />
            <div className="remodex-skeleton-bubble remodex-skeleton-user" />
            <div className="remodex-skeleton-bubble remodex-skeleton-assistant remodex-skeleton-wide" />
            <div className="remodex-skeleton-bubble remodex-skeleton-user remodex-skeleton-short" />
          </div>
        ) : (
          <div className="remodex-loading-card">
            {isOwnedCodexSession
              ? 'No run history yet — waiting for the first readable output.'
              : 'No transcript turns visible yet — latest activity may have been tool-heavy or compacted.'}
          </div>
        )}
      </div>

      {streamingText ? (
        <article className="remodex-message-card remodex-message-card-assistant remodex-streaming-card">
          <div className="remodex-message-header">
            <span className="remodex-speaker-label">{selectedSession ? agentDisplayName(selectedSession) : 'Mister'}</span>
            <div className="remodex-typing-bubble-dots" style={{ display: 'inline-flex', marginLeft: 6 }}>
              <span className="remodex-typing-dot" />
              <span className="remodex-typing-dot" />
              <span className="remodex-typing-dot" />
            </div>
          </div>
          <div className="remodex-streaming-preview" style={{ maxHeight: 60, overflow: 'hidden', fontSize: '0.85rem', lineHeight: 1.4, color: '#475569' }}>{formatStreamingPreview(streamingText)}</div>
        </article>
      ) : (waitingForResponse || actionState === 'steering') ? (
        <div className="remodex-typing-bubble">
          <span className="remodex-typing-bubble-label">{selectedSession ? agentDisplayName(selectedSession) : 'Mister'}</span>
          <div className="remodex-typing-bubble-dots">
            <span className="remodex-typing-dot" />
            <span className="remodex-typing-dot" />
            <span className="remodex-typing-dot" />
          </div>
        </div>
      ) : null}

      {hasNewMessages ? (
        <button
          type="button"
          onClick={() => {
            setHasNewMessages(false);
            onScrollToLatestMessage(true);
          }}
          style={{
            position: 'fixed',
            bottom: `${composeHeight + 16}px`,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 16px',
            borderRadius: '20px',
            backgroundColor: '#007aff',
            color: '#ffffff',
            fontSize: '13px',
            fontWeight: 600,
            border: 'none',
            boxShadow: '0 4px 16px rgba(0,122,255,0.35)',
            cursor: 'pointer',
            animation: 'pill-bounce-in 0.3s ease-out',
          }}
        >
          <span style={{ fontSize: '14px' }}>↓</span> New messages
          <style>{`@keyframes pill-bounce-in { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }`}</style>
        </button>
      ) : null}

      {isRefreshing && transcriptEntries.length > 0 ? (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '3px',
            background: 'linear-gradient(90deg, transparent, #007aff, transparent)',
            animation: 'stale-slide 1.5s ease-in-out infinite',
            zIndex: 10,
          }}
        >
          <style>{`@keyframes stale-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }`}</style>
        </div>
      ) : null}

      <MediaLightbox media={expandedMedia} onClose={() => setExpandedMedia(null)} />
    </>
  );
}
