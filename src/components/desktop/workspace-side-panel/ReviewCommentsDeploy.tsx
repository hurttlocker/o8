'use client';

import { memo } from 'react';
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Globe,
  MessageSquare,
} from 'lucide-react';
import { MarkdownBody } from '../MarkdownBody';
import {
  formatReviewCommentInjection,
  formatReviewCommentBatchInjection,
  type AgentPanelChatInjectionPayload,
} from '@/lib/chat/injection';
import type {
  WorkspaceSidePanelRepo,
  WorkspaceDeploymentItem,
  WorkspacePullRequestDetail,
  WorkspaceResolvedPullRequest,
  WorkspaceReviewComment,
  WorkspaceIssueComment,
} from './types';
import {
  formatAge,
  getFileIconColor,
  ContextActionChip,
  ContextIconButton,
  ReviewSection,
  ContextObjectCard,
  EmptySectionState,
} from './shared';

// ── Comments Section ─────────────────────────────────────────────────
export const ReviewCommentsSection = memo(function ReviewCommentsSection({
  expandedSection,
  onToggleSection,
  activePullRequest,
  repoSlug,
  onInjectChatContext,
  addedContextKeys,
  injectPayload,
  addCommentsToChat,
  commentsLoading,
  prDetail,
  issueComments,
  reviewComments,
  inlineCommentsByPath,
  allCommentContexts,
  repo,
}: {
  expandedSection: 'checks' | 'comments' | 'deploy' | null;
  onToggleSection: () => void;
  activePullRequest: WorkspaceResolvedPullRequest | null;
  repoSlug: string | null;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload, repo: WorkspaceSidePanelRepo | null) => void;
  addedContextKeys: Record<string, boolean>;
  injectPayload: (key: string, payload: AgentPanelChatInjectionPayload) => void;
  addCommentsToChat: () => void;
  commentsLoading: boolean;
  prDetail: WorkspacePullRequestDetail | null;
  issueComments: WorkspaceIssueComment[];
  reviewComments: WorkspaceReviewComment[];
  inlineCommentsByPath: [string, WorkspaceReviewComment[]][];
  allCommentContexts: Array<{ prNumber: number; repo?: string; author: string; body: string; createdAt: string; path?: string; line?: number | null }>;
  repo: WorkspaceSidePanelRepo | null;
}) {
  return (
    <ReviewSection
      title="Comments"
      collapsible
      open={expandedSection === 'comments'}
      onToggle={onToggleSection}
      actions={
        <>
          {activePullRequest && allCommentContexts.length > 0 && onInjectChatContext ? (
            <ContextActionChip
              icon={<MessageSquare size={11} strokeWidth={2} />}
              label={addedContextKeys[`comments:${activePullRequest.number}`] ? 'Added' : 'Add comments'}
              onClick={addCommentsToChat}
              disabled={Boolean(addedContextKeys[`comments:${activePullRequest.number}`])}
            />
          ) : null}
        </>
      }
    >
      {commentsLoading && !prDetail ? (
        <EmptySectionState>Loading review feedback...</EmptySectionState>
      ) : !activePullRequest ? (
        <EmptySectionState>No pull request is attached to this branch yet.</EmptySectionState>
      ) : issueComments.length === 0 && reviewComments.length === 0 ? (
        <EmptySectionState>No review comments need action right now.</EmptySectionState>
      ) : (
        <>
          {issueComments.length > 0 ? (
            <>
              <div style={{ padding: '0 2px', fontSize: 10, fontWeight: 700, color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>General</div>
              {issueComments.slice(0, 4).map((comment) => {
                const key = `issue-comment:${comment.id}`;
                const isBot = /\[bot\]$/i.test(comment.user);
                return (
                  <ContextObjectCard
                    key={comment.id}
                    itemKind="issue-comment"
                    itemId={String(comment.id)}
                    style={{ padding: '7px 8px', borderRadius: 9 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <MessageSquare size={13} strokeWidth={1.8} style={{ color: 'var(--t-text-secondary)', marginTop: 2, flexShrink: 0 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>{comment.user}</div>
                          {isBot ? (
                            <span style={{
                              display: 'inline-flex',
                              padding: '1px 6px',
                              borderRadius: 999,
                              background: 'var(--t-hover)',
                              color: 'var(--t-text-faint)',
                              fontSize: 8,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                            }}>
                              Bot
                            </span>
                          ) : null}
                          <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{formatAge(comment.created_at)}</span>
                        </div>
                        <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 10, background: 'var(--t-hover)' }}>
                          <MarkdownBody text={comment.body.trim() || 'No comment body'} compact />
                        </div>
                      </div>
                      {activePullRequest && onInjectChatContext ? (
                        <ContextActionChip
                          icon={<MessageSquare size={11} strokeWidth={2} />}
                          label={addedContextKeys[key] ? 'Added' : 'Add'}
                          onClick={() => injectPayload(
                            key,
                            formatReviewCommentInjection({
                              prNumber: activePullRequest.number,
                              repo: repoSlug ?? undefined,
                              author: comment.user,
                              body: comment.body,
                              createdAt: comment.created_at,
                            }),
                          )}
                          disabled={Boolean(addedContextKeys[key])}
                        />
                      ) : null}
                    </div>
                  </ContextObjectCard>
                );
              })}
            </>
          ) : null}

          {inlineCommentsByPath.length > 0 ? (
            <>
              <div style={{ padding: '8px 2px 0', fontSize: 10, fontWeight: 700, color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Inline Review</div>
              {inlineCommentsByPath.slice(0, 6).map(([path, comments]) => {
                const threadKey = `review-thread:${path}`;
                return (
                  <ContextObjectCard
                    key={path}
                    itemKind="review-thread"
                    itemId={path}
                    style={{ padding: '7px 8px', borderRadius: 9 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <FileText size={13} strokeWidth={1.8} style={{ color: getFileIconColor(path.split('/').pop() || path), marginTop: 2, flexShrink: 0 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>{path}</div>
                          <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{comments.length} comment{comments.length === 1 ? '' : 's'}</span>
                        </div>
                        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {comments.slice(0, 2).map((comment) => (
                            <div key={comment.id} style={{ fontSize: 10, color: 'var(--t-text-secondary)', lineHeight: 1.45 }}>
                              <span style={{ fontWeight: 700, color: 'var(--t-text)' }}>{comment.author}</span>
                              {comment.line ? ` \u00B7 L${comment.line}` : ''}
                              {` \u00B7 ${formatAge(comment.createdAt)}`}
                              <div style={{ marginTop: 4, padding: '6px 8px', borderRadius: 10, background: 'var(--t-hover)' }}>
                                <MarkdownBody text={comment.body.trim() || 'No comment body'} compact />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                      {activePullRequest && onInjectChatContext ? (
                        <ContextActionChip
                          icon={<MessageSquare size={11} strokeWidth={2} />}
                          label={addedContextKeys[threadKey] ? 'Added' : 'Add thread'}
                          onClick={() => injectPayload(
                            threadKey,
                            formatReviewCommentBatchInjection(
                              activePullRequest.number,
                              repoSlug ?? undefined,
                              comments.map((comment) => ({
                                prNumber: activePullRequest.number,
                                repo: repoSlug ?? undefined,
                                author: comment.author,
                                body: comment.body,
                                createdAt: comment.createdAt,
                                path: comment.path,
                                line: comment.line,
                              })),
                            ),
                          )}
                          disabled={Boolean(addedContextKeys[threadKey])}
                        />
                      ) : null}
                    </div>
                  </ContextObjectCard>
                );
              })}
            </>
          ) : null}
        </>
      )}
    </ReviewSection>
  );
});

// ── Deploy Section ───────────────────────────────────────────────────
export const ReviewDeploySection = memo(function ReviewDeploySection({
  expandedSection,
  onToggleSection,
  deploySummaryLabel,
  shouldShowDeployList,
  deployLoading,
  deployments,
}: {
  expandedSection: 'checks' | 'comments' | 'deploy' | null;
  onToggleSection: () => void;
  deploySummaryLabel: string;
  shouldShowDeployList: boolean;
  deployLoading: boolean;
  deployments: WorkspaceDeploymentItem[];
}) {
  return (
    <ReviewSection
      title="Deploy"
      collapsible
      open={expandedSection === 'deploy'}
      onToggle={onToggleSection}
      actions={<span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{deploySummaryLabel}</span>}
    >
      {!shouldShowDeployList ? (
        <EmptySectionState>Deploy becomes relevant after this pull request is merged.</EmptySectionState>
      ) : null}
      {shouldShowDeployList ? deployLoading && deployments.length === 0 ? (
        <EmptySectionState>Loading deploy state...</EmptySectionState>
      ) : deployments.length === 0 ? (
        <EmptySectionState>No deploy information is available yet.</EmptySectionState>
      ) : (
        deployments.slice(0, 5).map((deployment) => {
          const healthy = /ready|success/i.test(deployment.state);
          const pending = /queued|building|pending|in_progress/i.test(deployment.state);
          const tone = healthy
            ? { color: '#15803d', bg: 'rgba(34,197,94,0.10)' }
            : pending
              ? { color: '#b45309', bg: 'rgba(245,158,11,0.10)' }
              : { color: '#b91c1c', bg: 'rgba(239,68,68,0.10)' };
          return (
            <ContextObjectCard key={deployment.id} itemKind="deploy" itemId={deployment.id}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ display: 'inline-flex', width: 20, height: 20, borderRadius: 999, alignItems: 'center', justifyContent: 'center', background: tone.bg, color: tone.color, flexShrink: 0 }}>
                  {healthy ? <CheckCircle2 size={12} strokeWidth={2.2} /> : pending ? <Clock size={12} strokeWidth={2.2} /> : <Globe size={12} strokeWidth={2.2} />}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{deployment.label}</div>
                    <span style={{ display: 'inline-flex', padding: '2px 7px', borderRadius: 999, background: tone.bg, color: tone.color, fontSize: 10, fontWeight: 700 }}>
                      {deployment.state}
                    </span>
                  </div>
                  <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--t-text-muted)' }}>
                    {deployment.environment ? <span>{deployment.environment}</span> : null}
                    {deployment.sha ? <span>{deployment.sha}</span> : null}
                    {deployment.createdAt ? <span>{formatAge(deployment.createdAt)}</span> : null}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, justifyContent: 'flex-end' }}>
                  {deployment.url ? (
                    <ContextIconButton
                      icon={<ExternalLink size={11} strokeWidth={2} />}
                      label="Open deploy"
                      onClick={() => window.open(deployment.url, '_blank', 'noopener,noreferrer')}
                    />
                  ) : null}
                </div>
              </div>
            </ContextObjectCard>
          );
        })
      ) : null}
    </ReviewSection>
  );
});
