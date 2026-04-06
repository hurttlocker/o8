'use client';

import React, { memo } from 'react';
import {
  Check,
  MessageSquare,
  X,
} from 'lucide-react';
import {
  formatReviewCommentInjection,
  formatReviewCommentBatchInjection,
  type AgentPanelChatInjectionPayload,
} from '@/lib/chat/injection';
import { MarkdownBody } from '../MarkdownBody';
import { formatAge } from '../canvas-utils';
import { DesktopGlassActionChip } from './shared';

interface CommentItem {
  id: number;
  body: string;
  user: string;
  created_at: string;
  kind: 'comment' | 'review';
  path?: string;
  line?: number | null;
}

interface PRCommentsSectionProps {
  prNumber: number;
  visibleComments: CommentItem[];
  activeItemIndex: number;
  addedContextKeys: Record<string, true>;
  hoveredCommentKey: string | null;
  setHoveredCommentKey: (key: string | null) => void;
  injectPayload: (key: string, payload: AgentPanelChatInjectionPayload) => void;
  hideComment: (key: string) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
  repo?: string;
}

function PRCommentsSectionBase({
  prNumber,
  visibleComments,
  activeItemIndex,
  addedContextKeys,
  hoveredCommentKey,
  setHoveredCommentKey,
  injectPayload,
  hideComment,
  onInjectChatContext,
  repo,
}: PRCommentsSectionProps) {
  if (visibleComments.length === 0) {
    return (
      <div>
        <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>No comments</div>
      </div>
    );
  }

  return (
    <div>
      {onInjectChatContext ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <DesktopGlassActionChip
            icon={<MessageSquare size={12} strokeWidth={2} />}
            label={addedContextKeys[`comments-all:${prNumber}`] ? 'Added to chat' : 'Add all to chat'}
            onClick={() => injectPayload(
              `comments-all:${prNumber}`,
              formatReviewCommentBatchInjection(
                prNumber,
                repo,
                visibleComments.map((comment) => ({
                  prNumber,
                  repo,
                  author: comment.user,
                  body: comment.body,
                  createdAt: comment.created_at,
                  path: comment.kind === 'review' ? (comment as { path?: string }).path : undefined,
                })),
              ),
            )}
            disabled={Boolean(addedContextKeys[`comments-all:${prNumber}`])}
          />
        </div>
      ) : null}
      {visibleComments.map((comment, index) => {
        const commentKey = `${comment.kind}:${comment.id}`;
        const isBot = comment.user.endsWith('[bot]') || comment.user === 'github-actions';
        const isHovered = hoveredCommentKey === commentKey;
        const isAdded = Boolean(addedContextKeys[commentKey]);
        return (
          <div
            key={`${comment.kind}-${comment.id}`}
            data-pr-section="comments"
            data-pr-index={index}
            onMouseEnter={() => setHoveredCommentKey(commentKey)}
            onMouseLeave={() => setHoveredCommentKey(null)}
            style={{
              marginBottom: 4,
              paddingBottom: 8,
              paddingLeft: 10,
              paddingRight: 10,
              paddingTop: 8,
              borderRadius: 8,
              borderBottom: '1px solid #f3f4f6',
              background: activeItemIndex === index ? 'rgba(37,99,235,0.04)' : 'transparent',
              border: activeItemIndex === index ? '1px solid rgba(37,99,235,0.14)' : '1px solid transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: isBot ? '#6b7280' : '#111827', fontSize: isBot ? 11 : 12 }}>{comment.user}</span>
              {comment.kind === 'review' ? (
                <span style={{
                  fontSize: 10,
                  paddingTop: 1,
                  paddingRight: 5,
                  paddingBottom: 1,
                  paddingLeft: 5,
                  borderRadius: 4,
                  background: 'rgba(139,92,246,0.08)',
                  color: '#8b5cf6',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                }}>
                  {'path' in comment ? (comment as { path: string }).path : 'review'}
                </span>
              ) : null}
              <span style={{ color: '#9ca3af', fontSize: 11 }}>{formatAge(comment.created_at)}</span>
              {onInjectChatContext && (isHovered || isAdded) ? (
                <>
                  <div style={{ flex: 1 }} />
                  <DesktopGlassActionChip
                    icon={isAdded ? <Check size={11} strokeWidth={2.4} /> : <MessageSquare size={11} strokeWidth={2} />}
                    label={isAdded ? 'Added' : 'Add'}
                    onClick={() => injectPayload(
                      commentKey,
                      formatReviewCommentInjection({
                        prNumber,
                        repo,
                        author: comment.user,
                        body: comment.body,
                        createdAt: comment.created_at,
                        path: comment.kind === 'review' ? (comment as { path?: string }).path : undefined,
                      }),
                    )}
                    disabled={isAdded}
                  />
                  {isHovered ? (
                    <DesktopGlassActionChip
                      icon={<X size={11} strokeWidth={2.2} />}
                      label="Hide"
                      variant="muted"
                      onClick={() => hideComment(commentKey)}
                    />
                  ) : null}
                </>
              ) : null}
            </div>
            <div style={{ fontSize: isBot ? 12 : 13, lineHeight: 1.5 }}>
              <MarkdownBody text={comment.body} compact={isBot} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const PRCommentsSection = memo(PRCommentsSectionBase);
