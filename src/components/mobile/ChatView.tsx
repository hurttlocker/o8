'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { FileText, Image as ImageIcon } from 'lucide-react';
import type { MobileTranscriptMedia, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { ChatViewProps } from './types';
import { MediaLightbox } from './MediaLightbox';
import { MobileActivitySummaryRow, MobileArtifactCard } from './ReferencePrimitives';
import {
  formatStreamingPreview,
  isImageMedia,
  mediaHref,
} from './utils';
import { isSlashCommandText } from '@/lib/slash-commands';
import { measureHeight, useStreamingHeight } from '@/lib/pretext';

// ── Memoized message bubble — only re-renders when its own data changes ──

interface MessageBubbleProps {
  entry: ChatViewProps['transcriptEntries'][number];
  isLatest: boolean;
  isNewMessage: boolean;
  isExpanded: boolean;
  selectedReviewFile: ChatViewProps['selectedReviewFile'];
  renderMessageBody: ChatViewProps['renderMessageBody'];
  setExpandedMedia: ChatViewProps['setExpandedMedia'];
  onOpenDiff: ChatViewProps['onOpenDiff'];
  onToggleExpanded: (id: string) => void;
}

function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeToolCalls(toolCalls: MobileTranscriptToolCall[] | undefined) {
  if (!toolCalls?.length) {
    return null;
  }

  let commandCount = 0;
  let readCount = 0;
  let editCount = 0;
  let otherCount = 0;

  toolCalls.forEach((tool) => {
    const name = tool.name.toLowerCase();
    if (name === 'exec' || name === 'exec_command' || name === 'write_stdin') {
      commandCount += 1;
      return;
    }
    if (name === 'read' || name === 'read_file') {
      readCount += 1;
      return;
    }
    if (name === 'write' || name === 'write_file' || name === 'edit' || name === 'edit_file') {
      editCount += 1;
      return;
    }
    otherCount += 1;
  });

  const parts: string[] = [];
  if (commandCount > 0) parts.push(`Ran ${formatCount(commandCount, 'command')}`);
  if (readCount > 0) parts.push(`read ${formatCount(readCount, 'file')}`);
  if (editCount > 0) parts.push(`edited ${formatCount(editCount, 'file')}`);
  if (otherCount > 0 || parts.length === 0) parts.push(`ran ${formatCount(otherCount || toolCalls.length, 'tool')}`);

  return parts.join(', ');
}

function toolDetail(tool: MobileTranscriptToolCall) {
  const args = tool.args ?? {};
  const detail = [
    typeof args.file_path === 'string' ? args.file_path : null,
    typeof args.path === 'string' ? args.path : null,
    typeof args.command === 'string' ? args.command : null,
    typeof args.cmd === 'string' ? args.cmd : null,
    typeof args.query === 'string' ? args.query : null,
    typeof args.url === 'string' ? args.url : null,
    typeof tool.preview === 'string' ? tool.preview : null,
  ].find(Boolean);

  return typeof detail === 'string' ? detail : tool.name;
}

function extractArtifactPreview(text: string) {
  const match = text.match(/```(?:([^\n]*))\n([\s\S]*?)```/);
  if (!match) {
    return { bodyText: text, preview: null as string | null };
  }

  const preview = match[2].trim();
  const bodyText = text.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim();
  return { bodyText, preview: preview || null };
}

function buildArtifact(entryText: string, toolCalls: MobileTranscriptToolCall[] | undefined, selectedReviewFile: ChatViewProps['selectedReviewFile'], isLatest: boolean) {
  const fileTool = [...(toolCalls ?? [])].reverse().find((tool) => {
    const name = tool.name.toLowerCase();
    return name === 'write' || name === 'write_file' || name === 'edit' || name === 'edit_file' || name === 'read' || name === 'read_file';
  });

  const { bodyText, preview } = extractArtifactPreview(entryText);
  const filePath = typeof fileTool?.args?.file_path === 'string'
    ? fileTool.args.file_path
    : typeof fileTool?.args?.path === 'string'
      ? fileTool.args.path
      : (isLatest ? selectedReviewFile?.path : null);

  const selectedPreview = isLatest ? selectedReviewFile?.preview?.trim() : '';
  const artifactPreview = preview ?? selectedPreview ?? '';

  if (!filePath || !artifactPreview) {
    return {
      artifact: null,
      bodyText: entryText,
    };
  }

  const action = (() => {
    const name = fileTool?.name.toLowerCase() ?? '';
    if (name === 'read' || name === 'read_file') return 'Read';
    if (name === 'edit' || name === 'edit_file') return 'Edit';
    return 'Write';
  })();

  return {
    artifact: {
      action,
      path: filePath,
      preview: artifactPreview,
    },
    bodyText: bodyText || entryText,
  };
}

const MessageBubble = memo(function MessageBubble({
  entry,
  isLatest,
  isNewMessage,
  isExpanded,
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
      </div>
    );
  }

  const isCompaction = entry.type === 'compaction'
    || (entry.role === 'system' && entry.text.toLowerCase().includes('compaction'));
  if (isCompaction) {
    return (
      <div className="remodex-compaction-card">
        <span className="remodex-compaction-icon" aria-hidden="true">⟳</span>
        <span className="remodex-compaction-label">Context compacted</span>
        {entry.timestampLabel ? <span className="remodex-compaction-time">{entry.timestampLabel}</span> : null}
      </div>
    );
  }

  const activitySummary = summarizeToolCalls(entry.toolCalls);
  const artifactData = buildArtifact(entry.text, entry.toolCalls, selectedReviewFile, isLatest);

  return (
    <article className={`remodex-message-card remodex-message-card-assistant${fadeClass}`}>
      {activitySummary ? (
        <MobileActivitySummaryRow
          summary={activitySummary}
          expanded={isExpanded}
          onClick={() => onToggleExpanded(entry.id)}
        />
      ) : null}
      {isExpanded && entry.toolCalls?.length ? (
        <div className="remodex-reference-tool-detail-stack">
          {entry.toolCalls.map((tool, index) => (
            <div key={`${entry.id}-${tool.name}-${index}`} className="remodex-reference-tool-detail">
              <span className="remodex-reference-tool-name">{tool.name}</span>
              <code className="remodex-reference-tool-copy">{toolDetail(tool)}</code>
            </div>
          ))}
        </div>
      ) : null}
      {hasMedia ? <MediaGrid media={entry.media ?? []} setExpandedMedia={setExpandedMedia} /> : null}
      {artifactData.bodyText.trim() ? renderMessageBody(artifactData.bodyText, `${entry.id}-assistant`) : null}
      {artifactData.artifact ? (
        <div
          className="remodex-reference-artifact-button"
          role={isLatest && selectedReviewFile ? 'button' : undefined}
          tabIndex={isLatest && selectedReviewFile ? 0 : undefined}
          onClick={isLatest && selectedReviewFile ? onOpenDiff : undefined}
          onKeyDown={isLatest && selectedReviewFile ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpenDiff();
            }
          } : undefined}
        >
          <MobileArtifactCard
            action={artifactData.artifact.action}
            path={artifactData.artifact.path}
            preview={artifactData.artifact.preview}
          />
        </div>
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
  const latestVisibleEntryRef = useRef<{ sessionKey?: string; entryId: string | null }>({
    sessionKey: selectedSession?.sessionKey,
    entryId: transcriptEntries[transcriptEntries.length - 1]?.id ?? null,
  });
  const initialScrollSessionRef = useRef<string | null>(null);

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

  // [pretext] Track container width in a ref (NOT state) so estimateSize
  // remains stable — writing to a ref never triggers a re-render or causes
  // the virtualizer to recalculate all item sizes and jump scroll position.
  const containerWidthRef = useRef<number>(
    typeof window !== 'undefined' ? window.innerWidth - 32 : 300,
  );
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    containerWidthRef.current = node.clientWidth || window.innerWidth - 32;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        if (w > 0) containerWidthRef.current = w;
      }
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []); // mount-only — listRef.current is stable

  const estimateSize = useCallback((index: number) => {
    const entry = transcriptRef.current[index];
    if (!entry) return 80;
    const text = entry.text ?? '';
    const hasMedia = Boolean(entry.media?.length);
    const mediaExtra = hasMedia ? 240 : 0;
    // Count code blocks — they render much taller
    const codeBlocks = (text.match(/```/g) ?? []).length / 2;
    const codeExtra = Math.floor(codeBlocks) * 120;

    if (entry.role === 'system' && text.toLowerCase().includes('compaction')) return 44;

    const measuredWidth = containerWidthRef.current;
    if (measuredWidth > 0 && text) {
      // [pretext] Zero-reflow height measurement — pure math after Canvas prepare()
      const font = entry.role === 'user' ? 'body' : 'body';
      const measured = measureHeight(text, font, measuredWidth - 32);
      // 52px base (card chrome) + measured text height + code block overhead + media
      const base = entry.role === 'user' ? 52 : 64;
      return Math.max(base, base + measured + codeExtra + mediaExtra);
    }

    // Fallback when width not yet measured (first render before ResizeObserver fires)
    const textLen = text.length;
    const lineBreaks = (text.match(/\n/g) ?? []).length;
    const lineHeight = lineBreaks * 22;
    if (entry.role === 'user') return Math.max(52, 52 + Math.ceil(textLen / 50) * 22 + mediaExtra);
    const charEstimate = Math.ceil(textLen / 45) * 22;
    return Math.max(80, 64 + Math.max(charEstimate, lineHeight) + codeExtra + mediaExtra);
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

  /* eslint-disable react-hooks/set-state-in-effect -- local badge state depends on transcript append events */
  useEffect(() => {
    if (!selectedSession?.sessionKey || transcriptEntries.length === 0) return;
    if (initialScrollSessionRef.current === selectedSession.sessionKey) return;
    initialScrollSessionRef.current = selectedSession.sessionKey;
    setHasNewMessages(false);
    requestAnimationFrame(() => onScrollToLatestMessage(true));
  }, [selectedSession?.sessionKey, transcriptEntries.length, onScrollToLatestMessage]);

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

  // Keep the newest turn in view after a send/response cycle, but preserve
  // manual scroll control when the user intentionally browses older history.
  useEffect(() => {
    const latestEntry = transcriptEntries[transcriptEntries.length - 1] ?? null;
    const previous = latestVisibleEntryRef.current;
    const sessionChanged = previous.sessionKey !== selectedSession?.sessionKey;

    if (!latestEntry) {
      latestVisibleEntryRef.current = {
        sessionKey: selectedSession?.sessionKey,
        entryId: null,
      };
      return;
    }

    const latestChanged = previous.entryId !== latestEntry.id;
    if (!sessionChanged && latestChanged) {
      const shouldForceScroll = waitingForResponse || latestEntry.id.startsWith('optimistic-');
      if (shouldForceScroll || stickToBottomRef.current) {
        setHasNewMessages(false);
        requestAnimationFrame(() => onScrollToLatestMessage(shouldForceScroll));
      } else if (latestEntry.role === 'assistant') {
        setHasNewMessages(true);
      }
    }

    latestVisibleEntryRef.current = {
      sessionKey: selectedSession?.sessionKey,
      entryId: latestEntry.id,
    };
  }, [selectedSession?.sessionKey, transcriptEntries, waitingForResponse, onScrollToLatestMessage]);
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

  // [pretext] Streaming preview height — called unconditionally (hook ordering rule).
  // measureHeight is pure math (~0.09ms) so this is negligible cost even when streaming.
  // Using state-based width here (streaming card is outside the virtualizer — safe to be reactive).
  const [streamingContainerWidth] = useState<number>(
    typeof window !== 'undefined' ? Math.max(window.innerWidth - 56, 200) : 300,
  );
  const streamingPreviewHeight = useStreamingHeight(
    streamingText ?? '',
    'body',
    streamingContainerWidth,
    1.4,
  );

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
                padding: '10px 18px', borderRadius: 999, border: '1px solid rgba(219, 211, 198, 0.7)',
                background: 'rgba(255,255,255,0.82)',
                color: '#61584d', fontSize: 13, fontWeight: 600,
                cursor: loadingMore ? 'default' : 'pointer',
                opacity: loadingMore ? 0.5 : 1,
                WebkitTapHighlightColor: 'transparent',
                touchAction: 'manipulation',
                boxShadow: '0 10px 24px rgba(71, 61, 51, 0.06)',
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
                    isLatest={isLatest}
                    isNewMessage={isNew}
                    isExpanded={expandedMessageId === entry.id}
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
        {/* Bottom breathing room — keeps last message above compose bar + action buttons */}
        <div style={{ height: Math.max(composeHeight, 120) + 24 }} aria-hidden="true" />
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
                <span className="remodex-speaker-label">{selectedSession ? agentDisplayName(selectedSession) : 'Assistant'}</span>
                <div className="remodex-typing-bubble-dots" style={{ display: 'inline-flex', marginLeft: 6 }}>
                  <span className="remodex-typing-dot" />
                  <span className="remodex-typing-dot" />
                  <span className="remodex-typing-dot" />
                </div>
              </div>
              {/* [pretext] Explicit height instead of maxHeight+overflow to eliminate DOM reflow on each token */}
              <div className="remodex-streaming-preview" style={{ height: Math.min(streamingPreviewHeight || 22, 60), overflow: 'hidden', fontSize: '0.85rem', lineHeight: 1.4, color: '#475569' }}>{formatStreamingPreview(streamingText)}</div>
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
              <span className="remodex-typing-bubble-label">{selectedSession ? agentDisplayName(selectedSession) : 'Assistant'}</span>
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
            width: 36,
            height: 36,
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.76)',
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            color: '#413a31',
            fontSize: 14,
            fontWeight: 600,
            boxShadow: '0 12px 30px rgba(71, 61, 51, 0.12)',
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
