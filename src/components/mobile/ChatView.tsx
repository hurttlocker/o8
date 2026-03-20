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
import { isSlashCommandText } from '@/lib/slash-commands';

// ── Memoized message bubble — only re-renders when its own data changes ──

interface MessageBubbleProps {
  entry: ChatViewProps['transcriptEntries'][number];
  previousEntry: ChatViewProps['transcriptEntries'][number] | null;
  isLatest: boolean;
  isNewMessage: boolean;
  isExpanded: boolean;
  isOwnedCodexSession: boolean;
  selectedSession: ChatViewProps['selectedSession'];
  selectedReviewFile: ChatViewProps['selectedReviewFile'];
  renderMessageBody: ChatViewProps['renderMessageBody'];
  setExpandedMedia: ChatViewProps['setExpandedMedia'];
  onOpenDiff: ChatViewProps['onOpenDiff'];
  onToggleExpanded: (id: string) => void;
}

function shouldIgnoreToggleTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && Boolean(target.closest('a, button, code, pre, input, textarea'));
}

const MessageBubble = memo(function MessageBubble({
  entry,
  previousEntry,
  isLatest,
  isNewMessage,
  isExpanded,
  isOwnedCodexSession,
  selectedSession,
  selectedReviewFile,
  renderMessageBody,
  setExpandedMedia,
  onOpenDiff,
  onToggleExpanded,
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
    const isSlashCommand = isSlashCommandText(entry.text);
    return (
      <div className={`remodex-user-turn-wrap${fadeClass}`}>
        {hasMedia ? <MediaGrid media={entry.media ?? []} setExpandedMedia={setExpandedMedia} /> : null}
        {hasText ? (
          <div
            className="remodex-user-bubble"
            style={isSlashCommand ? {
              background: 'rgba(15, 23, 42, 0.92)',
              color: '#f8fafc',
              border: '1px solid rgba(148, 163, 184, 0.18)',
              boxShadow: '0 8px 24px rgba(15, 23, 42, 0.14)',
            } : undefined}
          >
            {isSlashCommand ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: '#93c5fd',
                }}>
                  Slash Command
                </span>
              </div>
            ) : null}
            <div style={isSlashCommand ? { fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: '0.88rem' } : undefined}>
              {renderMessageBody(entry.text, `${entry.id}-user`)}
            </div>
          </div>
        ) : null}
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
    <article
      className={`remodex-message-card remodex-message-card-assistant${fadeClass}`}
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
      onClick={(e) => {
        if (shouldIgnoreToggleTarget(e.target)) return;
        onToggleExpanded(entry.id);
      }}
      onTouchEnd={(e) => {
        if (shouldIgnoreToggleTarget(e.target)) return;
        onToggleExpanded(entry.id);
        e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onToggleExpanded(entry.id);
      }}
      style={{ cursor: 'pointer', WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
    >
      {speakerChanged ? (
        <div className="remodex-message-head">
          <span>{roleLabel(entry.role, agentName)}</span>
        </div>
      ) : null}
      {hasMedia ? <MediaGrid media={entry.media ?? []} setExpandedMedia={setExpandedMedia} /> : null}
      {hasText ? renderMessageBody(entry.text, `${entry.id}-assistant`) : null}
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
        <MessageActions messageId={entry.id} messageText={entry.text} visible={isExpanded} />
      ) : null}
    </article>
  );
});

// ── Media grid (extracted for memo boundary) ──

function MediaGrid({
  media,
  setExpandedMedia,
}: {
  media: MobileTranscriptMedia[];
  setExpandedMedia: (media: MobileTranscriptMedia | null) => void;
}) {
  const images = media.filter(isImageMedia);
  const files = media.filter(m => !isImageMedia(m));
  const imgCount = images.length;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 0,
      width: '100%',
    }}>
      {imgCount > 0 ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: imgCount === 1 ? '1fr' : '1fr 1fr',
          gap: 2,
          borderRadius: 14,
          overflow: 'hidden',
          width: '100%',
          marginBottom: 0,
        }}>
          {images.map((item, i) => {
            const span = imgCount === 3 && i === 0;
            return (
              <button
                key={item.path}
                type="button"
                onClick={() => setExpandedMedia(item)}
                style={{
                  gridColumn: span ? '1 / -1' : undefined,
                  margin: 0, padding: 0, border: 'none',
                  background: '#e5e5ea',
                  cursor: 'pointer', display: 'block',
                  WebkitTapHighlightColor: 'transparent',
                  overflow: 'hidden',
                  lineHeight: 0,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mediaHref(item.path)}
                  alt={item.name}
                  loading="lazy"
                  style={{
                    width: '100%',
                    height: imgCount === 1 ? 'auto' : 160,
                    maxHeight: imgCount === 1 ? 400 : undefined,
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              </button>
            );
          })}
        </div>
      ) : null}

      {files.map((item) => (
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
      ))}
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
  onLoadMore,
  hasMoreHistory = true,
}: ChatViewProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [canLoadMore, setCanLoadMore] = useState(hasMoreHistory);
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
  const toggleExpanded = useCallback((id: string) => {
    setExpandedMessageId((prev) => prev === id ? null : id);
  }, []);
  const prevEntryCountRef = useRef(transcriptEntries.length);

  // Track which messages are "new" (not yet seen) via state, avoiding
  // render-time ref access (#195). The effect computes the new set and
  // updates the seen ref in one pass. The setState here is intentional —
  // this is derived state that depends on a mutable ref and cannot be
  // computed in useMemo without accessing the ref during render.
  const [newMessageIds, setNewMessageIds] = useState<Set<string>>(new Set());

  /* eslint-disable react-hooks/set-state-in-effect -- derived from mutable ref, cannot use useMemo (#195) */
  useEffect(() => {
    if (!hydrated || !seenMessageIdsRef.current || seenMessageIdsRef.current.size === 0) {
      setNewMessageIds(prev => prev.size === 0 ? prev : new Set());
      return;
    }
    const ids = new Set<string>();
    for (const entry of transcriptEntries) {
      if (!seenMessageIdsRef.current.has(entry.id)) {
        ids.add(entry.id);
        seenMessageIdsRef.current.add(entry.id);
      }
    }
    setNewMessageIds(prev => ids.size === 0 && prev.size === 0 ? prev : ids);
  }, [hydrated, transcriptEntries, seenMessageIdsRef]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Stable estimateSize — must NOT depend on transcriptEntries to avoid
  // virtualizer recalculating all sizes on every poll update, which causes
  // scroll position to jump randomly on mobile.
  // Synced via effect to avoid render-time ref mutation (#195).
  const transcriptRef = useRef(transcriptEntries);
  useEffect(() => { transcriptRef.current = transcriptEntries; }, [transcriptEntries]);

  const estimateSize = useCallback((index: number) => {
    const entry = transcriptRef.current[index];
    if (!entry) return 80;
    const text = entry.text ?? '';
    const textLen = text.length;
    const hasMedia = Boolean(entry.media?.length);
    // Count code blocks — they render much taller
    const codeBlocks = (text.match(/```/g) ?? []).length / 2;
    const codeExtra = Math.floor(codeBlocks) * 120;
    // Count line breaks — better proxy for height than char count
    const lineBreaks = (text.match(/\n/g) ?? []).length;
    const lineHeight = lineBreaks * 22;
    if (entry.role === 'user') return Math.max(52, 52 + Math.ceil(textLen / 50) * 22 + (hasMedia ? 240 : 0));
    if (entry.role === 'system' && text.toLowerCase().includes('compaction')) return 44;
    // Use the larger of char-based or line-based estimate
    const charEstimate = Math.ceil(textLen / 45) * 22;
    return Math.max(80, 64 + Math.max(charEstimate, lineHeight) + codeExtra + (hasMedia ? 240 : 0));
  }, []);

  // Track scrollMargin via state to avoid render-time ref access (#195).
  const [scrollMargin, setScrollMargin] = useState(0);
  /* eslint-disable react-hooks/set-state-in-effect -- resetting local UI state when the virtualized transcript is replaced */
  useEffect(() => {
    if (listRef.current) setScrollMargin(listRef.current.offsetTop);
  }, [transcriptEntries.length]); // re-measure when list size changes

  const getItemKey = useCallback((index: number) => transcriptRef.current[index]?.id ?? `row-${index}`, []);
  const virtualizer = useWindowVirtualizer({
    count: transcriptEntries.length,
    estimateSize,
    getItemKey,
    overscan: 6,
    scrollMargin,
  });

  const transcriptIds = useMemo(
    () => transcriptEntries.map((entry) => entry.id),
    [transcriptEntries],
  );
  const previousVirtualStateRef = useRef<{ sessionKey?: string; ids: string[] }>({
    sessionKey: selectedSession?.sessionKey,
    ids: transcriptIds,
  });

  useEffect(() => {
    const previous = previousVirtualStateRef.current;
    const sessionChanged = previous.sessionKey !== selectedSession?.sessionKey;
    const appendedOnly = (
      !sessionChanged
      && transcriptIds.length >= previous.ids.length
      && previous.ids.every((id, index) => transcriptIds[index] === id)
    );
    const idsChanged = (
      transcriptIds.length !== previous.ids.length
      || transcriptIds.some((id, index) => previous.ids[index] !== id)
    );

    if (sessionChanged || (idsChanged && !appendedOnly)) {
      virtualizer.measure();
      setExpandedMessageId(null);
      setHasNewMessages(false);
    }

    previousVirtualStateRef.current = {
      sessionKey: selectedSession?.sessionKey,
      ids: transcriptIds,
    };
  }, [selectedSession?.sessionKey, transcriptIds, virtualizer]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // No auto-scroll — user controls position via "new messages" button.
  // Only scroll to bottom on initial load (first non-zero entry set).
  const initialScrollDone = useRef(false);
  /* eslint-disable react-hooks/set-state-in-effect -- local badge state depends on transcript append events */
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
  /* eslint-enable react-hooks/set-state-in-effect */

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
        {/* Load earlier messages */}
        {hasEntries && onLoadMore && canLoadMore ? (
          <div style={{ textAlign: 'center', padding: '12px 0 4px' }}>
            <button
              type="button"
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                const added = await onLoadMore();
                if (added === 0) setCanLoadMore(false);
                setLoadingMore(false);
              }}
              onTouchEnd={async (e) => {
                e.preventDefault();
                if (loadingMore) return;
                setLoadingMore(true);
                const added = await (onLoadMore?.() ?? Promise.resolve(0));
                if (added === 0) setCanLoadMore(false);
                setLoadingMore(false);
              }}
              style={{
                padding: '8px 20px', borderRadius: 10, border: 'none',
                background: 'rgba(0,122,255,0.06)',
                color: '#007aff', fontSize: 13, fontWeight: 600,
                cursor: loadingMore ? 'default' : 'pointer',
                opacity: loadingMore ? 0.5 : 1,
                WebkitTapHighlightColor: 'transparent',
                touchAction: 'manipulation',
              }}
            >
              {loadingMore ? 'Loading...' : 'Load earlier messages'}
            </button>
          </div>
        ) : null}
        {hasEntries ? (
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {virtualItems.map((virtualRow) => {
              const entry = transcriptEntries[virtualRow.index];
              const previousEntry = virtualRow.index > 0 ? transcriptEntries[virtualRow.index - 1] : null;
              const isLatest = virtualRow.index === lastAssistantIndex;
              const isNew = newMessageIds.has(entry.id);

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
                    previousEntry={previousEntry}
                    isLatest={isLatest}
                    isNewMessage={isNew}
                    isExpanded={expandedMessageId === entry.id}
                    isOwnedCodexSession={isOwnedCodexSession}
                    selectedSession={selectedSession}
                    selectedReviewFile={selectedReviewFile}
                    renderMessageBody={renderMessageBody}
                    setExpandedMedia={setExpandedMedia}
                    onOpenDiff={onOpenDiff}
                    onToggleExpanded={toggleExpanded}
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

      {(() => {
        // Detect active compaction — last message mentions compact while waiting
        const lastEntry = transcriptEntries[transcriptEntries.length - 1];
        const isCompacting = (waitingForResponse || actionState === 'steering')
          && lastEntry
          && lastEntry.text?.toLowerCase().includes('compact');

        if (streamingText && !isCompacting) {
          return (
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
          );
        }

        if (isCompacting) {
          return (
            <div style={{
              margin: '8px 14px',
              padding: '14px 16px',
              borderRadius: 16,
              background: 'rgba(255,149,0,0.06)',
              border: '1px solid rgba(255,149,0,0.15)',
              backdropFilter: 'blur(20px) saturate(1.6)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              {/* Header with spinner */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <div style={{
                  width: 18, height: 18, borderRadius: '50%',
                  border: '2.5px solid rgba(255,149,0,0.25)',
                  borderTopColor: '#ff9500',
                  animation: 'spin 1s linear infinite',
                  flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 14, fontWeight: 700,
                  color: '#ff9500',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}>
                  Compacting context
                </span>
              </div>

              {/* Description */}
              <p style={{
                margin: 0, fontSize: 12, lineHeight: 1.5,
                color: '#8e8e93',
              }}>
                {selectedSession ? agentDisplayName(selectedSession) : 'Agent'} is compressing context to free up memory. Messages you send now will be queued and delivered after compaction completes.
              </p>

              {/* Animated progress bar */}
              <div style={{
                height: 4, borderRadius: 2,
                background: 'rgba(255,149,0,0.12)',
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  background: 'linear-gradient(90deg, #ff9500, #ffcc00)',
                  width: '65%',
                  animation: 'compactPulse 2s ease-in-out infinite',
                }} />
              </div>

              {/* Tip */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 10px',
                borderRadius: 8,
                background: 'rgba(255,149,0,0.04)',
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                  stroke="#ff9500" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                <span style={{
                  fontSize: 11, color: '#8e8e93', fontWeight: 500,
                }}>
                  Usually takes 10–30 seconds
                </span>
              </div>
            </div>
          );
        }

        if (waitingForResponse || actionState === 'steering') {
          return (
            <div className="remodex-typing-bubble">
              <span className="remodex-typing-bubble-label">{selectedSession ? agentDisplayName(selectedSession) : 'Mister'}</span>
              <div className="remodex-typing-bubble-dots">
                <span className="remodex-typing-dot" />
                <span className="remodex-typing-dot" />
                <span className="remodex-typing-dot" />
              </div>
            </div>
          );
        }

        return null;
      })()}

      {hasNewMessages ? (
        <button
          type="button"
          aria-label="Jump to newest message"
          onClick={() => {
            setHasNewMessages(false);
            onScrollToLatestMessage(true);
          }}
          style={{
            position: 'fixed',
            bottom: `${composeHeight + 48}px`,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: 10,
            border: '1px solid rgba(0,122,255,0.15)',
            background: 'rgba(0,122,255,0.08)',
            backdropFilter: 'blur(20px) saturate(1.6)',
            WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
            color: '#007aff',
            fontSize: 14,
            fontWeight: 600,
            boxShadow: '0 2px 12px rgba(0,122,255,0.15)',
            cursor: 'pointer',
            animation: 'pill-bounce-in 0.3s ease-out',
          }}
        >
          ↓
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
