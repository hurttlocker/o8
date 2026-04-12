'use client';

import React, { memo } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  RotateCcw,
  Send,
} from 'lucide-react';
import {
  formatReviewCommentBatchInjection,
  formatReviewThreadInjection,
  type AgentPanelChatInjectionPayload,
} from '@/lib/chat/injection';
import { MarkdownBody } from '../MarkdownBody';
import { formatAge } from '../canvas-utils';
import { renderDiffLines } from '../diff-utils';
import type { ReviewThread, ReviewThreadStatus } from './types';
import { reviewThreadTone, formatReviewThreadLocation, DesktopGlassActionChip } from './shared';

interface PRReviewThreadsSectionProps {
  prNumber: number;
  visibleReviewThreads: ReviewThread[];
  reviewsLoading: boolean;
  reviewThreadsError: string | null;
  activeItemIndex: number;
  addedContextKeys: Record<string, true>;
  viewedThreadIds: Record<string, true>;
  setViewedThreadIds: React.Dispatch<React.SetStateAction<Record<string, true>>>;
  collapsedThreadIds: Record<string, true>;
  replyDrafts: Record<string, string>;
  setReplyDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  threadActionLoading: Record<string, 'reply' | 'resolve' | 'unresolve'>;
  injectPayload: (key: string, payload: AgentPanelChatInjectionPayload) => void;
  toggleViewedThread: (threadId: string) => void;
  toggleCollapsedThread: (threadId: string) => void;
  submitThreadReply: (threadId: string) => void;
  submitThreadResolve: (threadId: string, resolved: boolean) => void;
  fetchReviewThreads: () => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
  repo?: string;
}

function PRReviewThreadsSectionBase({
  prNumber,
  visibleReviewThreads,
  reviewsLoading,
  reviewThreadsError,
  activeItemIndex,
  addedContextKeys,
  viewedThreadIds,
  setViewedThreadIds,
  collapsedThreadIds,
  replyDrafts,
  setReplyDrafts,
  threadActionLoading,
  injectPayload,
  toggleViewedThread,
  toggleCollapsedThread,
  submitThreadReply,
  submitThreadResolve,
  fetchReviewThreads,
  onInjectChatContext,
  repo,
}: PRReviewThreadsSectionProps) {
  const reviewThreadCounts = {
    active: visibleReviewThreads.filter((thread) => thread.status === 'active').length,
    outdated: visibleReviewThreads.filter((thread) => thread.status === 'outdated').length,
    resolved: visibleReviewThreads.filter((thread) => thread.status === 'resolved').length,
  };

  return (
    <div>
      {visibleReviewThreads.length > 0 ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {(['active', 'outdated', 'resolved'] as ReviewThreadStatus[]).map((status) => {
              const tone = reviewThreadTone(status);
              const count = reviewThreadCounts[status];
              return (
                <span
                  key={status}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    paddingTop: 4,
                    paddingRight: 10,
                    paddingBottom: 4,
                    paddingLeft: 10,
                    borderRadius: 999,
                    border: `1px solid ${tone.pillBorder}`,
                    background: tone.pillBackground,
                    color: tone.color,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {tone.label}
                  <span style={{ color: 'var(--t-text-secondary)' }}>{count}</span>
                </span>
              );
            })}
          </div>
          {onInjectChatContext ? (
            <DesktopGlassActionChip
              icon={<MessageSquare size={12} strokeWidth={2} />}
              label={addedContextKeys[`review-threads-all:${prNumber}`] ? 'Added to chat' : 'Add all to chat'}
              onClick={() => injectPayload(
                `review-threads-all:${prNumber}`,
                formatReviewCommentBatchInjection(
                  prNumber,
                  repo,
                  visibleReviewThreads.flatMap((thread) => thread.comments.map((comment) => ({
                    prNumber,
                    repo,
                    author: comment.author,
                    body: comment.body,
                    createdAt: comment.createdAt,
                    path: comment.path,
                    line: comment.line,
                  }))),
                ),
              )}
              disabled={Boolean(addedContextKeys[`review-threads-all:${prNumber}`])}
            />
          ) : null}
        </div>
      ) : null}

      {reviewThreadsError ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 12,
          paddingRight: 14,
          paddingBottom: 12,
          paddingLeft: 14,
          borderRadius: 16,
          border: '1px solid rgba(239,68,68,0.16)',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.88), rgba(254,242,242,0.82))',
          boxShadow: '0 14px 28px rgba(239, 68, 68, 0.08)',
          marginBottom: 12,
          flexWrap: 'wrap',
        }}>
          <AlertCircle size={16} strokeWidth={2.1} style={{ color: '#b91c1c', flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 180, fontSize: 13, color: '#991b1b' }}>
            {reviewThreadsError}
          </span>
          <button
            type="button"
            onClick={() => { fetchReviewThreads(); }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              minHeight: 44,
              paddingTop: 8,
              paddingRight: 14,
              paddingBottom: 8,
              paddingLeft: 14,
              borderRadius: 999,
              border: '1px solid rgba(239,68,68,0.18)',
              background: 'rgba(255,255,255,0.82)',
              color: '#b91c1c',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            <RotateCcw size={14} strokeWidth={2} />
            Retry
          </button>
        </div>
      ) : null}

      {reviewsLoading && visibleReviewThreads.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>Loading review threads...</div>
      ) : null}

      {!reviewsLoading && visibleReviewThreads.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>No review threads</div>
      ) : null}

      {visibleReviewThreads.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {visibleReviewThreads.map((thread, index) => (
            <ReviewThreadCard
              key={thread.id}
              thread={thread}
              index={index}
              prNumber={prNumber}
              activeItemIndex={activeItemIndex}
              addedContextKeys={addedContextKeys}
              viewedThreadIds={viewedThreadIds}
              setViewedThreadIds={setViewedThreadIds}
              collapsedThreadIds={collapsedThreadIds}
              replyDrafts={replyDrafts}
              setReplyDrafts={setReplyDrafts}
              threadActionLoading={threadActionLoading}
              injectPayload={injectPayload}
              toggleViewedThread={toggleViewedThread}
              toggleCollapsedThread={toggleCollapsedThread}
              submitThreadReply={submitThreadReply}
              submitThreadResolve={submitThreadResolve}
              onInjectChatContext={onInjectChatContext}
              repo={repo}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const PRReviewThreadsSection = memo(PRReviewThreadsSectionBase);

/* ------------------------------------------------------------------ */
/*  ReviewThreadCard                                                    */
/* ------------------------------------------------------------------ */

interface ReviewThreadCardProps {
  thread: ReviewThread;
  index: number;
  prNumber: number;
  activeItemIndex: number;
  addedContextKeys: Record<string, true>;
  viewedThreadIds: Record<string, true>;
  setViewedThreadIds: React.Dispatch<React.SetStateAction<Record<string, true>>>;
  collapsedThreadIds: Record<string, true>;
  replyDrafts: Record<string, string>;
  setReplyDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  threadActionLoading: Record<string, 'reply' | 'resolve' | 'unresolve'>;
  injectPayload: (key: string, payload: AgentPanelChatInjectionPayload) => void;
  toggleViewedThread: (threadId: string) => void;
  toggleCollapsedThread: (threadId: string) => void;
  submitThreadReply: (threadId: string) => void;
  submitThreadResolve: (threadId: string, resolved: boolean) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
  repo?: string;
}

function ReviewThreadCardBase({
  thread,
  index,
  prNumber,
  activeItemIndex,
  addedContextKeys,
  viewedThreadIds,
  setViewedThreadIds,
  collapsedThreadIds,
  replyDrafts,
  setReplyDrafts,
  threadActionLoading,
  injectPayload,
  toggleViewedThread,
  toggleCollapsedThread,
  submitThreadReply,
  submitThreadResolve,
  onInjectChatContext,
  repo,
}: ReviewThreadCardProps) {
  const threadKey = `review-thread:${thread.id}`;
  const tone = reviewThreadTone(thread.status);
  const isViewed = Boolean(viewedThreadIds[thread.id]);
  const isCollapsed = Boolean(collapsedThreadIds[thread.id]);
  const location = formatReviewThreadLocation(thread);
  const latestComment = thread.comments[thread.comments.length - 1] ?? null;
  const threadLoadingState = threadActionLoading[thread.id] ?? null;

  return (
    <div
      data-pr-section="reviews"
      data-pr-index={index}
      style={{
        borderRadius: 18,
        border: activeItemIndex === index
          ? `1px solid ${tone.accent}`
          : `1px solid ${tone.border}`,
        background: tone.background,
        boxShadow: activeItemIndex === index
          ? '0 18px 32px rgba(37, 99, 235, 0.12)'
          : '0 10px 24px rgba(15, 23, 42, 0.05)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => {
          toggleCollapsedThread(thread.id);
          setViewedThreadIds((current) => ({ ...current, [thread.id]: true }));
        }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          minHeight: 44,
          paddingTop: 14,
          paddingRight: 16,
          paddingBottom: 14,
          paddingLeft: 16,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        }}
      >
        <span style={{
          width: 30,
          height: 30,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 999,
          background: tone.pillBackground,
          color: tone.color,
          flexShrink: 0,
        }}>
          {isCollapsed ? <ChevronRight size={16} strokeWidth={2.1} /> : <ChevronDown size={16} strokeWidth={2.1} />}
        </span>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--t-text-strong)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              textDecorationLine: tone.summaryDecoration,
            }}>
              {thread.path}
            </span>
            {location ? (
              <span style={{
                fontSize: 11,
                color: 'var(--t-text-secondary)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}>
                L{location}
              </span>
            ) : null}
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              paddingTop: 3,
              paddingRight: 8,
              paddingBottom: 3,
              paddingLeft: 8,
              borderRadius: 999,
              border: `1px solid ${tone.pillBorder}`,
              background: tone.pillBackground,
              color: tone.color,
              fontSize: 10,
              fontWeight: 800,
            }}>
              {tone.label}
            </span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              paddingTop: 3,
              paddingRight: 8,
              paddingBottom: 3,
              paddingLeft: 8,
              borderRadius: 999,
              border: `1px solid ${isViewed ? 'rgba(22,163,74,0.18)' : 'rgba(245,158,11,0.18)'}`,
              background: isViewed ? 'rgba(22,163,74,0.10)' : 'rgba(245,158,11,0.10)',
              color: isViewed ? '#15803d' : '#b45309',
              fontSize: 10,
              fontWeight: 800,
            }}>
              {isViewed ? 'Viewed' : 'Unviewed'}
            </span>
            {thread.resolvedBy ? (
              <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                resolved by {thread.resolvedBy}
              </span>
            ) : null}
          </div>
          <div style={{
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--t-text-secondary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textDecorationLine: tone.summaryDecoration,
          }}>
            {latestComment?.body.trim() || 'Review thread'}
          </div>
        </div>
        <span style={{ fontSize: 11, color: 'var(--t-text-muted)', flexShrink: 0 }}>
          {latestComment?.createdAt ? formatAge(latestComment.createdAt) : ''}
        </span>
      </button>

      {!isCollapsed ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          paddingTop: 0,
          paddingRight: 16,
          paddingBottom: 16,
          paddingLeft: 16,
        }}>
          {thread.comments[0]?.diffHunk ? (
            <pre style={{
              marginTop: 0,
              marginRight: 0,
              marginBottom: 0,
              marginLeft: 0,
              paddingTop: 10,
              paddingRight: 12,
              paddingBottom: 10,
              paddingLeft: 12,
              fontSize: '0.72rem',
              lineHeight: 1.5,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--t-text-secondary)',
              background: 'rgba(255,255,255,0.72)',
              borderRadius: 14,
              border: `1px solid ${tone.border}`,
              maxHeight: 140,
              overflowY: 'auto',
            }}>
              {renderDiffLines(thread.comments[0].diffHunk)}
            </pre>
          ) : null}

          {thread.comments.map((comment) => (
            <div
              key={comment.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                paddingTop: 12,
                paddingRight: 14,
                paddingBottom: 12,
                paddingLeft: 14,
                borderRadius: 16,
                border: `1px solid ${comment.isOptimistic ? 'rgba(245,158,11,0.22)' : 'rgba(148,163,184,0.18)'}`,
                background: comment.isOptimistic
                  ? 'linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,251,235,0.78))'
                  : 'rgba(255,255,255,0.72)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text-strong)' }}>{comment.author}</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{formatAge(comment.createdAt)}</span>
                {comment.line ? (
                  <span style={{
                    fontSize: 10,
                    color: 'var(--t-text-secondary)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}>
                    line {comment.line}
                  </span>
                ) : null}
                {comment.isOptimistic ? (
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    paddingTop: 3,
                    paddingRight: 8,
                    paddingBottom: 3,
                    paddingLeft: 8,
                    borderRadius: 999,
                    border: '1px solid rgba(245,158,11,0.18)',
                    background: 'rgba(245,158,11,0.10)',
                    color: '#b45309',
                    fontSize: 10,
                    fontWeight: 800,
                  }}>
                    Sending...
                  </span>
                ) : null}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.6, opacity: comment.isOptimistic ? 0.76 : 1 }}>
                <MarkdownBody text={comment.body} />
              </div>
            </div>
          ))}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}>
            {onInjectChatContext ? (
              <DesktopGlassActionChip
                icon={addedContextKeys[threadKey] ? <Check size={12} strokeWidth={2.4} /> : <MessageSquare size={12} strokeWidth={2} />}
                label={addedContextKeys[threadKey] ? 'Added to chat' : 'Add thread to chat'}
                onClick={() => {
                  injectPayload(
                    threadKey,
                    formatReviewThreadInjection({
                      prNumber,
                      repo,
                      status: thread.status,
                      path: thread.path,
                      line: thread.line,
                      comments: thread.comments.map((c) => ({
                        prNumber,
                        repo,
                        author: c.author,
                        body: c.body,
                        createdAt: c.createdAt,
                        path: c.path,
                        line: c.line,
                      })),
                    }),
                  );
                  setViewedThreadIds((current) => ({ ...current, [thread.id]: true }));
                }}
                disabled={Boolean(addedContextKeys[threadKey])}
              />
            ) : <div />}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => toggleViewedThread(thread.id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  minHeight: 44,
                  paddingTop: 8,
                  paddingRight: 14,
                  paddingBottom: 8,
                  paddingLeft: 14,
                  borderRadius: 999,
                  border: '1px solid rgba(148,163,184,0.22)',
                  background: 'rgba(255,255,255,0.78)',
                  color: isViewed ? '#475569' : '#b45309',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                }}
              >
                {isViewed ? 'Mark unviewed' : 'Mark viewed'}
              </button>
              {(thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve) ? (
                <button
                  type="button"
                  onClick={() => { submitThreadResolve(thread.id, !thread.isResolved); }}
                  disabled={threadLoadingState === 'resolve' || threadLoadingState === 'unresolve'}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    minHeight: 44,
                    paddingTop: 8,
                    paddingRight: 14,
                    paddingBottom: 8,
                    paddingLeft: 14,
                    borderRadius: 999,
                    border: `1px solid ${thread.isResolved ? 'rgba(96,165,250,0.22)' : 'rgba(22,163,74,0.18)'}`,
                    background: thread.isResolved
                      ? 'rgba(219,234,254,0.72)'
                      : 'rgba(220,252,231,0.72)',
                    color: thread.isResolved ? '#1d4ed8' : '#15803d',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: threadLoadingState ? 'wait' : 'pointer',
                    fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                    opacity: threadLoadingState ? 0.74 : 1,
                  }}
                >
                  {threadLoadingState === 'resolve' || threadLoadingState === 'unresolve'
                    ? 'Saving...'
                    : thread.isResolved
                      ? 'Reopen thread'
                      : 'Resolve thread'}
                </button>
              ) : null}
            </div>
          </div>

          {thread.viewerCanReply ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              paddingTop: 12,
              paddingRight: 14,
              paddingBottom: 12,
              paddingLeft: 14,
              borderRadius: 16,
              border: `1px solid ${tone.border}`,
              background: 'rgba(255,255,255,0.78)',
            }}>
              <textarea
                value={replyDrafts[thread.id] ?? ''}
                onChange={(event) => setReplyDrafts((current) => ({ ...current, [thread.id]: event.target.value }))}
                placeholder="Reply to this thread..."
                rows={3}
                style={{
                  width: '100%',
                  minHeight: 88,
                  resize: 'vertical',
                  border: '1px solid rgba(148,163,184,0.24)',
                  borderRadius: 14,
                  paddingTop: 10,
                  paddingRight: 12,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  fontSize: 13,
                  lineHeight: 1.5,
                  background: 'rgba(248,250,252,0.92)',
                  color: 'var(--t-text)',
                  outline: 'none',
                  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                }}
              />
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
              }}>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                  {replyDrafts[thread.id]?.trim()
                    ? `${replyDrafts[thread.id].trim().length} characters ready`
                    : 'Draft stays local until the reply succeeds.'}
                </span>
                <button
                  type="button"
                  onClick={() => { submitThreadReply(thread.id); }}
                  disabled={!replyDrafts[thread.id]?.trim() || threadLoadingState === 'reply'}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    minHeight: 44,
                    paddingTop: 8,
                    paddingRight: 16,
                    paddingBottom: 8,
                    paddingLeft: 16,
                    borderRadius: 999,
                    border: '1px solid rgba(37,99,235,0.18)',
                    background: !replyDrafts[thread.id]?.trim()
                      ? 'rgba(148,163,184,0.18)'
                      : threadLoadingState === 'reply'
                        ? 'rgba(37,99,235,0.18)'
                        : '#2563eb',
                    color: !replyDrafts[thread.id]?.trim() ? 'var(--t-text-muted)' : '#fff',
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: !replyDrafts[thread.id]?.trim() ? 'default' : threadLoadingState === 'reply' ? 'wait' : 'pointer',
                    fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                  }}
                >
                  <Send size={14} strokeWidth={2.2} />
                  {threadLoadingState === 'reply' ? 'Sending...' : 'Reply'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const ReviewThreadCard = memo(ReviewThreadCardBase);
