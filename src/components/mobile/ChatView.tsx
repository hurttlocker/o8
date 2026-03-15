import Image from 'next/image';
import { ChevronRight, FileDiff, FileText, Image as ImageIcon } from 'lucide-react';
import type { MobileTranscriptMedia } from '@/lib/mobile/types';
import type { ChatViewProps } from './types';
import { MediaLightbox } from './MediaLightbox';
import {
  formatStreamingPreview,
  isImageMedia,
  mediaHref,
  roleLabel,
} from './utils';

export function ChatView({
  transcriptEntries,
  transcriptLoading,
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
  function renderMediaGrid(media: MobileTranscriptMedia[], align: 'left' | 'right' = 'left') {
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
                <Image
                  src={mediaHref(item.path)}
                  alt={item.name}
                  width={1200}
                  height={900}
                  unoptimized
                  loading="lazy"
                  onLoadingComplete={() => {
                    onScrollToLatestMessage();
                  }}
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

  return (
    <>
      <div className="remodex-message-stack">
        {transcriptEntries.length ? transcriptEntries.map((entry, index) => {
          const isUser = entry.role === 'user';
          const isLatest = !transcriptEntries.slice(index + 1).some((item) => item.role === 'assistant');
          const hasText = Boolean(entry.text.trim());
          const hasMedia = Boolean(entry.media?.length);
          const isNewMessage = hydrated
            && seenMessageIdsRef.current != null
            && seenMessageIdsRef.current.size > 0
            && !seenMessageIdsRef.current.has(entry.id);
          if (isNewMessage) {
            seenMessageIdsRef.current?.add(entry.id);
          }
          const fadeClass = isNewMessage ? ' remodex-turn-new' : '';
          const previousEntry = index > 0 ? transcriptEntries[index - 1] : null;
          const speakerChanged = !previousEntry || previousEntry.role !== entry.role;
          const showTimestamp = (() => {
            if (!previousEntry?.timestampLabel || !entry.timestampLabel) {
              return speakerChanged;
            }
            const previous = new Date(`1970-01-01 ${previousEntry.timestampLabel}`).getTime();
            const current = new Date(`1970-01-01 ${entry.timestampLabel}`).getTime();
            if (Number.isNaN(previous) || Number.isNaN(current)) {
              return speakerChanged;
            }
            return Math.abs(current - previous) >= 15 * 60 * 1000;
          })();

          if (isUser) {
            return (
              <div key={entry.id} className={`remodex-user-turn-wrap${fadeClass}`}>
                {hasText ? <div className="remodex-user-bubble">{renderMessageBody(entry.text, `${entry.id}-user`)}</div> : null}
                {hasMedia ? renderMediaGrid(entry.media ?? [], 'right') : null}
                {showTimestamp ? <span className="remodex-turn-time">{entry.timestampLabel ?? 'now'}</span> : null}
              </div>
            );
          }

          const isCompaction = entry.role === 'system' && entry.text.toLowerCase().includes('compaction');
          if (isCompaction) {
            return (
              <div key={entry.id} className="remodex-compaction-card">
                <span className="remodex-compaction-icon" aria-hidden="true">⟳</span>
                <span className="remodex-compaction-label">Context compacted</span>
                {showTimestamp ? <span className="remodex-compaction-time">{entry.timestampLabel ?? ''}</span> : null}
              </div>
            );
          }

          const agentName = isOwnedCodexSession ? 'Codex' : (selectedSession?.isCurrentSession ? 'Mister' : undefined);

          return (
            <article key={entry.id} className={`remodex-message-card remodex-message-card-assistant${fadeClass}`}>
              {speakerChanged ? (
                <div className="remodex-message-head">
                  <span>{roleLabel(entry.role, agentName)}</span>
                </div>
              ) : null}
              {hasText ? renderMessageBody(entry.text, `${entry.id}-assistant`) : null}
              {hasMedia ? renderMediaGrid(entry.media ?? []) : null}
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
            </article>
          );
        }) : transcriptLoading ? (
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

      <MediaLightbox media={expandedMedia} onClose={() => setExpandedMedia(null)} />
    </>
  );
}
