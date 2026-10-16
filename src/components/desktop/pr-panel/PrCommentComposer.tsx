'use client';

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { ArrowUp, Brain, CheckCircle2, ChevronDown, ExternalLink, MessageSquare } from '../lucide-shims';
import { usePrComment } from './usePrComment';
import { PrReviewChoices } from './PrReviewChoices';
import type { PrComposerMode, PrDetail, PrReviewAction } from './types';

const postedLabels = { comment: 'Comment posted.', 'close-with-comment': 'Comment posted and pull request closed.', close: 'Pull request closed.', 'review-comment': 'Review submitted.', approve: 'Approval submitted.', 'request-changes': 'Changes requested.' };
export function PrCommentComposer({ detail, repoSlug, mode = 'comment', onModeChange, draft, onDraftChange, reviewAction = 'review-comment', onReviewActionChange, reviewHeadSha, onReviewHeadChange, onBrain, onCollapse, onPosted }: {
  detail: PrDetail; repoSlug?: string | null; mode?: 'comment' | 'review'; onModeChange?: (mode: PrComposerMode) => void;
  draft: string; onDraftChange: (draft: string) => void; reviewAction?: PrReviewAction; onReviewActionChange?: (action: PrReviewAction) => void;
  reviewHeadSha?: string; onReviewHeadChange?: () => void; onBrain: () => void; onCollapse: () => void; onPosted?: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const currentDraft = useRef(draft);
  const mounted = useRef(true);
  useLayoutEffect(() => { currentDraft.current = draft; }, [draft]);
  useEffect(() => { mounted.current = true; input.current?.focus({ preventScroll: true }); return () => { mounted.current = false; }; }, [mode]);
  const repo = detail.resolvedRepo || repoSlug;
  const delivery = usePrComment(repo, detail.number);
  const isReview = mode === 'review';
  const headIsCurrent = Boolean(reviewHeadSha && reviewHeadSha === detail.headSha);
  const needsBody = !isReview || reviewAction !== 'approve';
  const canPost = Boolean(repo && (!needsBody || draft.trim()) && !delivery.busy && !delivery.uncertain && !delivery.partialClose && (!isReview || headIsCurrent));
  const submit = async (action: 'comment' | 'close-with-comment' | 'close' | PrReviewAction) => {
    const sent = draft;
    if (await delivery.post(action === 'close' ? '' : sent, action, isReview ? reviewHeadSha : undefined) && mounted.current) {
      if (action !== 'close' && currentDraft.current === sent) onDraftChange('');
      onPosted?.();
    }
  };
  return <>
    <header style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, paddingTop: 7, paddingRight: 10, paddingBottom: 7, paddingLeft: 12, borderBottom: '1px solid var(--t-divider-subtle)' }}>
      <button type="button" onClick={onBrain} aria-label="Switch to Brain" style={modeStyle}><Brain size={13} aria-hidden="true" />Brain</button>
      {(['comment', 'review'] as const).map((choice) => <button key={choice} type="button" aria-label={'Switch to ' + choice} aria-pressed={mode === choice} onClick={() => onModeChange?.(choice)} style={{ ...modeStyle, color: mode === choice ? 'var(--t-text)' : 'var(--t-text-muted)', background: mode === choice ? 'var(--t-hover)' : 'transparent' }}>{choice === 'comment' ? <MessageSquare size={13} aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />}{choice === 'comment' ? 'Comment' : 'Review'}</button>)}
      <span style={{ flex: 1 }} /><button type="button" aria-label={`Collapse ${mode} composer`} onClick={onCollapse} style={{ ...modeStyle, padding: 0, width: 28, height: 28 }}><ChevronDown size={15} aria-hidden="true" /></button>
    </header>
    <div style={noticeStyle}>Posts to {repo || 'the connected repository'} · PR #{detail.number} on GitHub.</div>
    {isReview ? <>
      <PrReviewChoices value={reviewAction} onChange={(action) => onReviewActionChange?.(action)} disabled={delivery.busy} />
      {headIsCurrent ? <div style={noticeStyle}>Reviewing commit {reviewHeadSha?.slice(0, 7)}.</div> : <div role="status" style={{ ...noticeStyle, color: 'var(--t-warning)' }}>{reviewHeadSha ? 'This pull request has a newer commit.' : 'Load the current commit before reviewing.'} <button type="button" disabled={!detail.headSha || delivery.busy} onClick={onReviewHeadChange} style={modeStyle}>Use latest commit</button></div>}
    </> : null}
    {delivery.error ? <div role="alert" style={{ ...noticeStyle, fontSize: 11, color: 'var(--t-danger)' }}>{delivery.error} <a href={detail.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--t-accent)' }}>Open GitHub <ExternalLink size={11} aria-hidden="true" /></a>{delivery.uncertain ? <button type="button" onClick={delivery.acknowledge} style={modeStyle}>I&apos;ve checked GitHub</button> : null}{delivery.partialClose && !delivery.uncertain ? <button type="button" disabled={delivery.busy} onClick={() => void submit('close')} style={modeStyle}>{delivery.busy ? 'Closing…' : 'Retry close'}</button> : null}</div> : null}
    {delivery.posted && !delivery.partialClose ? <div role="status" style={{ ...noticeStyle, fontSize: 11, color: 'var(--t-success)' }}>{postedLabels[(delivery.postedAction || 'comment') as keyof typeof postedLabels] || 'Pull request updated.'} <a href={detail.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--t-accent)' }}>View on GitHub</a></div> : null}
    <form aria-label={`${isReview ? 'Review' : 'Comment on'} PR #${detail.number}`} onSubmit={(event) => { event.preventDefault(); if (canPost) void submit(isReview ? reviewAction : 'comment'); }} style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0, paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 14 }}>
      <textarea ref={input} data-pr-comment={!isReview ? detail.number : undefined} data-pr-review={isReview ? detail.number : undefined} aria-label={`GitHub ${mode} on PR #${detail.number}`} placeholder={isReview ? reviewAction === 'approve' ? 'Review feedback (optional)' : 'Leave review feedback' : 'Leave a comment'} value={draft} onChange={(event) => onDraftChange(event.target.value)} style={{ flex: 1, minHeight: 44, resize: 'none', border: 0, padding: 0, background: 'transparent', color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.6, overflowY: 'auto' }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
        {!isReview && detail.state.toLowerCase() === 'open' ? <button type="button" disabled={!canPost} onClick={() => void submit('close-with-comment')} style={{ ...postStyle, background: 'transparent', borderColor: 'var(--t-border)', color: 'var(--t-danger)', opacity: canPost ? 1 : 0.5 }}>Close with comment</button> : null}
        <button type="submit" disabled={!canPost} style={{ ...postStyle, background: canPost ? 'var(--t-accent)' : 'var(--t-hover)', color: canPost ? 'var(--t-success-contrast)' : 'var(--t-text-muted)', opacity: canPost ? 1 : 0.6 }}>{delivery.busy ? 'Submitting…' : isReview ? 'Submit review' : 'Post comment'}<ArrowUp size={13} aria-hidden="true" /></button>
      </div>
    </form>
  </>;
}
const noticeStyle: CSSProperties = { flexShrink: 0, paddingTop: 8, paddingRight: 14, paddingBottom: 0, paddingLeft: 14, fontSize: 10, color: 'var(--t-text-muted)' };
const modeStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 26, border: 0, borderRadius: 7, paddingTop: 0, paddingRight: 8, paddingBottom: 0, paddingLeft: 8, color: 'var(--t-text-muted)', background: 'transparent', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' };
const postStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 30, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, fontFamily: 'inherit', fontSize: 11, borderRadius: 8, border: '1px solid var(--t-accent-border)', cursor: 'pointer' };
