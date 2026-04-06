'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  GitBranch,
  GitMerge,
  GitPullRequest,
  MessageSquare,
} from 'lucide-react';
import { ApprovalQueuePanel } from '../ApprovalQueuePanel';
import { deriveWorkflowStage, describeWorkflowStage, workflowBadge } from '@/lib/workflows/status';
import {
  formatCiCheckBatchInjection,
  formatReviewCommentBatchInjection,
  type AgentPanelChatInjectionPayload,
} from '@/lib/chat/injection';
import type {
  WorkspaceSidePanelRepo,
  WorkspaceChatTargetOption,
  WorkspaceResolvedPullRequest,
  WorkspaceReviewComment,
} from './types';
import {
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  normalizeBranchName,
  branchesMatch,
  groupWorkflowRuns,
  worktreeStateLabel,
  worktreeStateTone,
  prStateLabel,
  ChatTargetSelector,
  ContextHintBadge,
  ContextActionChip,
  PrimaryActionButton,
  ReviewSection,
  ContextObjectCard,
} from './shared';
import { ReviewChecksSection } from './ReviewChecksHover';
import { ReviewCommentsSection, ReviewDeploySection } from './ReviewCommentsDeploy';
import { useReviewData, usePrDetail, useRunDetail } from './useReviewData';

export const ReviewTab = memo(function ReviewTab({
  repo,
  preferredPullRequestNumber,
  compactReview,
  chatTargetLabel,
  chatTargets,
  selectedChatTargetKey,
  onSelectChatTarget,
  onInjectChatContext,
  onOpenPullRequest,
  onDeepReviewPullRequest,
  onExpandReviewRail,
}: {
  repo: WorkspaceSidePanelRepo | null;
  preferredPullRequestNumber?: number | null;
  compactReview?: boolean;
  chatTargetLabel?: string | null;
  chatTargets?: WorkspaceChatTargetOption[];
  selectedChatTargetKey?: string | null;
  onSelectChatTarget?: (sessionKey: string) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload, repo: WorkspaceSidePanelRepo | null) => void;
  onOpenPullRequest?: (prNumber: number, repo?: string) => void;
  onDeepReviewPullRequest?: (prNumber: number, repo?: string) => void;
  onExpandReviewRail?: () => void;
}) {
  const [hoveredRunId, setHoveredRunId] = useState<number | null>(null);
  const [hoveredRunRect, setHoveredRunRect] = useState<DOMRect | null>(null);
  const [expandedSection, setExpandedSection] = useState<'checks' | 'comments' | 'deploy' | null>('checks');
  const [addedContextKeys, setAddedContextKeys] = useState<Record<string, boolean>>({});
  const [reviewActionLoading, setReviewActionLoading] = useState<'merge' | null>(null);
  const [reviewActionResult, setReviewActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [reviewReloadNonce, setReviewReloadNonce] = useState(0);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextResultTimerRef = useRef<number | null>(null);

  // ── Data fetching hooks ─────────────────────────────────────────────
  const {
    snapshot, loading, checks, checksLoading,
    deployments, deployLoading, repoSlug,
  } = useReviewData(repo, reviewReloadNonce);

  // ── Derived PR state ───────────────────────────────────────────────
  const currentBranch = normalizeBranchName(repo?.branch ?? snapshot?.branch ?? null);
  const branchPullRequest = useMemo(
    () => snapshot?.pullRequests.find((pullRequest) => branchesMatch(pullRequest.headRefName, currentBranch)) ?? null,
    [currentBranch, snapshot?.pullRequests],
  );
  const preferredPullRequest = useMemo(
    () => (
      preferredPullRequestNumber
        ? snapshot?.pullRequests.find((pullRequest) => pullRequest.number === preferredPullRequestNumber) ?? null
        : null
    ),
    [preferredPullRequestNumber, snapshot?.pullRequests],
  );
  const currentPullRequest = useMemo(
    () => {
      if (branchPullRequest) return branchPullRequest;
      if (preferredPullRequest && branchesMatch(preferredPullRequest.headRefName, currentBranch)) {
        return preferredPullRequest;
      }
      return null;
    },
    [branchPullRequest, currentBranch, preferredPullRequest],
  );
  const resolvedPullRequest = useMemo<WorkspaceResolvedPullRequest | null>(() => {
    if (currentPullRequest) return currentPullRequest;
    return null;
  }, [currentPullRequest]);
  const chatTargetHint = chatTargetLabel?.trim() ? `To ${chatTargetLabel.trim()}` : null;
  const chatTargetControl = chatTargets && chatTargets.length > 0 && selectedChatTargetKey && onSelectChatTarget
    ? (
        <ChatTargetSelector
          options={chatTargets}
          selectedSessionKey={selectedChatTargetKey}
          onSelect={onSelectChatTarget}
        />
      )
    : chatTargetHint
      ? <ContextHintBadge label={chatTargetHint} />
      : null;
  const reviewBranch = useMemo(
    () => normalizeBranchName(resolvedPullRequest?.headRefName ?? currentBranch),
    [currentBranch, resolvedPullRequest?.headRefName],
  );
  const activePullRequest = resolvedPullRequest;

  // ── Fetch PR detail ────────────────────────────────────────────────
  const { prDetail, commentsLoading } = usePrDetail(currentPullRequest?.number ?? null, repoSlug, reviewReloadNonce);

  const activeReadiness = useMemo(
    () => (
      activePullRequest
        ? (prDetail?.pr.readiness ?? null)
        : (repo?.readiness ?? null)
    ),
    [activePullRequest, prDetail?.pr.readiness, repo?.readiness],
  );
  const otherBranchPullRequestCount = useMemo(() => {
    const pullRequests = snapshot?.pullRequests ?? [];
    if (!currentBranch) return pullRequests.length;
    return pullRequests.filter((pullRequest) => !branchesMatch(pullRequest.headRefName, currentBranch)).length;
  }, [currentBranch, snapshot?.pullRequests]);

  useEffect(() => {
    setAddedContextKeys({});
    setReviewActionResult(null);
    setReviewActionLoading(null);
  }, [repo?.localPath, resolvedPullRequest?.number]);

  // ── Chat injection ─────────────────────────────────────────────────
  const injectPayload = useCallback((key: string, payload: AgentPanelChatInjectionPayload) => {
    if (!onInjectChatContext) return;
    onInjectChatContext(payload, repo);
    setAddedContextKeys((current) => ({ ...current, [key]: true }));
    if (contextResultTimerRef.current) {
      window.clearTimeout(contextResultTimerRef.current);
    }
    setReviewActionResult({
      type: 'success',
      message: `Added to ${chatTargetLabel?.trim() || 'Chat'}.`,
    });
    contextResultTimerRef.current = window.setTimeout(() => {
      setReviewActionResult((current) => (
        current?.message === `Added to ${chatTargetLabel?.trim() || 'Chat'}.`
          ? null
          : current
      ));
    }, 3200);
  }, [chatTargetLabel, onInjectChatContext, repo]);

  useEffect(() => () => {
    if (contextResultTimerRef.current) {
      window.clearTimeout(contextResultTimerRef.current);
    }
  }, []);

  // ── Scoped checks ─────────────────────────────────────────────────
  const scopedChecks = useMemo(() => {
    if (!reviewBranch) return checks;
    const exactMatches = checks.filter((check) => branchesMatch(check.headBranch, reviewBranch));
    return exactMatches;
  }, [checks, reviewBranch]);
  const failedChecks = useMemo(
    () => scopedChecks.filter((check) => Boolean(check.conclusion) && check.conclusion.toLowerCase() !== 'success'),
    [scopedChecks],
  );
  const pendingChecks = useMemo(
    () => scopedChecks.filter((check) => !check.conclusion || check.status?.toLowerCase() !== 'completed'),
    [scopedChecks],
  );
  const groupedChecks = useMemo(
    () => groupWorkflowRuns(scopedChecks, reviewBranch),
    [reviewBranch, scopedChecks],
  );

  // ── Hover logic ────────────────────────────────────────────────────
  const openRunHover = useCallback((runId: number, rect: DOMRect) => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    setHoveredRunId(runId);
    setHoveredRunRect(rect);
  }, []);

  const scheduleRunHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = setTimeout(() => {
      setHoveredRunId(null);
      setHoveredRunRect(null);
    }, 140);
  }, []);

  const { runDetail, detailLoading } = useRunDetail(hoveredRunId, repoSlug);

  const hoveredRun = useMemo(
    () => scopedChecks.find((check) => check.databaseId === hoveredRunId) ?? null,
    [hoveredRunId, scopedChecks],
  );
  const hoveredGroup = useMemo(
    () => groupedChecks.find((group) => group.runs.some((run) => run.databaseId === hoveredRunId)) ?? null,
    [groupedChecks, hoveredRunId],
  );

  // ── Comments ───────────────────────────────────────────────────────
  const reviewComments = useMemo(() => prDetail?.pr.reviewComments ?? [], [prDetail?.pr.reviewComments]);
  const issueComments = useMemo(() => prDetail?.pr.issueComments ?? [], [prDetail?.pr.issueComments]);
  const inlineCommentsByPath = useMemo(() => {
    const grouped = new Map<string, WorkspaceReviewComment[]>();
    for (const comment of reviewComments) {
      const key = comment.path || 'inline-review';
      const current = grouped.get(key) ?? [];
      current.push(comment);
      grouped.set(key, current);
    }
    return Array.from(grouped.entries());
  }, [reviewComments]);
  const allCommentContexts = useMemo(() => [
    ...issueComments.map((comment) => ({
      prNumber: activePullRequest?.number ?? 0,
      repo: repoSlug ?? undefined,
      author: comment.user,
      body: comment.body,
      createdAt: comment.created_at,
    })),
    ...reviewComments.map((comment) => ({
      prNumber: activePullRequest?.number ?? 0,
      repo: repoSlug ?? undefined,
      author: comment.author,
      body: comment.body,
      createdAt: comment.createdAt,
      path: comment.path,
      line: comment.line,
    })),
  ], [activePullRequest?.number, issueComments, repoSlug, reviewComments]);
  const requestedChangesCount = useMemo(() => {
    const decision = activePullRequest?.reviewDecision?.toLowerCase() ?? '';
    return decision === 'changes_requested' ? 1 : 0;
  }, [activePullRequest?.reviewDecision]);

  // ── Workflow stage ─────────────────────────────────────────────────
  const reviewStage = useMemo(
    () => {
      const workflowKey = prDetail?.pr.workflowStage?.key ?? null;
      if (workflowKey) {
        return workflowBadge(workflowKey as Parameters<typeof workflowBadge>[0]);
      }
      return deriveWorkflowStage({
        prState: activePullRequest?.state,
        failedChecks: failedChecks.length,
        pendingChecks: pendingChecks.length,
        requestedChanges: requestedChangesCount,
      readinessState: activeReadiness?.state ?? null,
    });
    },
    [activePullRequest?.state, activeReadiness?.state, failedChecks.length, pendingChecks.length, prDetail?.pr.workflowStage?.key, requestedChangesCount],
  );
  const reviewGuidance = useMemo(
    () => describeWorkflowStage({
      stage: reviewStage,
      prState: activePullRequest?.state,
      failedChecks: failedChecks.length,
      pendingChecks: pendingChecks.length,
      requestedChanges: requestedChangesCount,
      readinessState: activeReadiness?.state ?? null,
      readinessSummary: activeReadiness?.summary ?? null,
      readinessNextAction: activeReadiness?.nextAction ?? null,
    }),
    [activePullRequest?.state, activeReadiness?.nextAction, activeReadiness?.state, activeReadiness?.summary, failedChecks.length, pendingChecks.length, requestedChangesCount, reviewStage],
  );
  const reviewStageLabel = activePullRequest
    ? (prDetail?.pr.workflowStage?.label ?? reviewGuidance.stage?.label ?? prStateLabel(activePullRequest).label)
    : (activeReadiness?.label ?? 'No PR');

  // ── Auto-expand section based on state ─────────────────────────────
  useEffect(() => {
    if ((failedChecks.length + pendingChecks.length) > 0) {
      setExpandedSection('checks');
      return;
    }
    if (allCommentContexts.length > 0) {
      setExpandedSection('comments');
      return;
    }
    if (activePullRequest?.state?.toLowerCase() === 'merged') {
      setExpandedSection('deploy');
      return;
    }
    setExpandedSection('checks');
  }, [activePullRequest?.number, activePullRequest?.state, allCommentContexts.length, failedChecks.length, pendingChecks.length]);

  // ── Summary labels ─────────────────────────────────────────────────
  const shouldShowDeployList = !activePullRequest || activePullRequest.state?.toLowerCase() === 'merged';
  const deploySummaryLabel = shouldShowDeployList
    ? (deployments.length > 0 ? `${deployments.length} deployment${deployments.length === 1 ? '' : 's'}` : deployLoading ? 'Loading...' : 'No deploys')
    : 'Post-merge';
  const compactChecksSummary = failedChecks.length > 0
    ? `${failedChecks.length} failing`
    : pendingChecks.length > 0
      ? `${pendingChecks.length} pending`
      : activePullRequest
        ? 'PR checks clean'
        : 'Repo runs available';
  const compactCommentsSummary = allCommentContexts.length > 0
    ? `${allCommentContexts.length} comment${allCommentContexts.length === 1 ? '' : 's'}`
    : 'No comments';
  const compactDeploySummary = shouldShowDeployList
    ? (deployments.length > 0 ? `${deployments.length} deployment${deployments.length === 1 ? '' : 's'}` : 'No deploys')
    : 'Post-merge only';

  // ── Worktrees ──────────────────────────────────────────────────────
  const reviewSnapshot = snapshot;
  const scopedWorktrees = useMemo(() => {
    if (!reviewSnapshot?.worktrees.length) return [] as import('@/lib/fleet/types').ReviewWorktreeSummary[];
    if (!currentBranch) {
      return reviewSnapshot.worktrees.filter((worktree) => worktree.isCurrent);
    }
    const exactMatches = reviewSnapshot.worktrees.filter((worktree) => branchesMatch(worktree.branch, currentBranch));
    return exactMatches.length > 0
      ? exactMatches
      : reviewSnapshot.worktrees.filter((worktree) => worktree.isCurrent);
  }, [currentBranch, reviewSnapshot]);

  // ── Actions ────────────────────────────────────────────────────────
  const openBranchPullRequest = useCallback(() => {
    if (!repoSlug || !currentBranch) return;
    window.open(`https://github.com/${repoSlug}/compare/main...${currentBranch}?expand=1`, '_blank', 'noopener,noreferrer');
  }, [currentBranch, repoSlug]);

  const submitPullRequestAction = useCallback(async (action: 'merge') => {
    if (!activePullRequest || !repoSlug) return;
    setReviewActionLoading(action);
    setReviewActionResult(null);
    try {
      const res = await fetch(`/api/panel/prs/${activePullRequest.number}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, repo: repoSlug }),
      });
      const data = await res.json() as { error?: string; action?: string };
      if (!res.ok) {
        throw new Error(data.error || `Unable to ${action} pull request`);
      }
      setReviewActionResult({
        type: 'success',
        message: action === 'merge' ? `Merged PR #${activePullRequest.number}.` : 'Action completed.',
      });
      setReviewReloadNonce((value) => value + 1);
    } catch (error) {
      setReviewActionResult({
        type: 'error',
        message: error instanceof Error ? error.message : `Unable to ${action} pull request`,
      });
    } finally {
      setReviewActionLoading(null);
    }
  }, [activePullRequest, repoSlug]);

  const addFailedChecksToChat = useCallback(() => {
    if (!activePullRequest?.number || !failedChecks.length) return;
    injectPayload(
      `checks:${activePullRequest.number}`,
      formatCiCheckBatchInjection(
        activePullRequest.number,
        repoSlug ?? undefined,
        failedChecks.map((check) => ({
          prNumber: activePullRequest.number,
          repo: repoSlug ?? undefined,
          name: check.workflowName || check.displayTitle || 'Workflow',
          status: check.status,
          conclusion: check.conclusion,
          detailsUrl: check.url,
          startedAt: check.createdAt,
          completedAt: check.updatedAt,
        })),
      ),
    );
  }, [activePullRequest, failedChecks, injectPayload, repoSlug]);

  const addCommentsToChat = useCallback(() => {
    if (!activePullRequest?.number || !allCommentContexts.length) return;
    injectPayload(
      `comments:${activePullRequest.number}`,
      formatReviewCommentBatchInjection(
        activePullRequest.number,
        repoSlug ?? undefined,
        allCommentContexts,
      ),
    );
  }, [activePullRequest, allCommentContexts, injectPayload, repoSlug]);

  // ── Loading / empty states ─────────────────────────────────────────
  if (loading && !snapshot) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ApprovalQueuePanel embedded />
        <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading review...</div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ApprovalQueuePanel embedded />
        <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>No review surface available yet</div>
      </div>
    );
  }

  const scopeLabel = currentBranch
    ? (repo?.isWorktree ? `${currentBranch} \u00B7 worktree` : currentBranch)
    : (repo?.name ?? 'Workspace');

  return (
    <div className="cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto', paddingBottom: 10 }}>
      <ApprovalQueuePanel embedded />

      {/* ── Review State Section ──────────────────────────────────────── */}
      <ReviewSection title="Review State">
        <ContextObjectCard itemKind="review-state" itemId={activePullRequest ? `pr:${activePullRequest.number}` : repo?.localPath ?? 'review-state'}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <GitPullRequest
                size={14}
                style={{
                  color: activePullRequest ? prStateLabel(activePullRequest).color : 'var(--t-text-faint)',
                  marginTop: 2,
                  flexShrink: 0,
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>
                    {activePullRequest ? `PR #${activePullRequest.number}` : 'No branch PR attached'}
                  </div>
                  <span
                    style={{
                      display: 'inline-flex',
                      padding: '2px 7px',
                      borderRadius: 999,
                      background: reviewGuidance.stage?.background ?? 'var(--t-divider-subtle)',
                      color: reviewGuidance.stage?.color ?? 'var(--t-text-secondary)',
                      fontSize: 10,
                      fontWeight: 700,
                    }}
                  >
                    {reviewStageLabel}
                  </span>
                  {reviewBranch ? (
                    <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                      {reviewBranch}
                    </span>
                  ) : null}
                  <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>
                    Scoped to {scopeLabel}
                  </span>
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
                  {activePullRequest
                    ? activePullRequest.title
                    : 'Open a pull request for this branch or worktree before treating review as a merge lane.'}
                </div>
                <div style={{ marginTop: 5, fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>
                  {activePullRequest
                    ? compactReview
                      ? 'Deep review is open in the center pane. Use this rail for merge and lightweight context.'
                      : reviewGuidance.detail
                    : activeReadiness?.summary
                      ?? (otherBranchPullRequestCount > 0
                        ? `This branch or worktree does not have an attached pull request yet. ${otherBranchPullRequestCount} repo pull request${otherBranchPullRequestCount === 1 ? '' : 's'} exist on other branches.`
                        : 'This branch or worktree does not have an attached pull request yet.')}
                </div>
                {activePullRequest && !compactReview && reviewGuidance.nextAction ? (
                  <div style={{ marginTop: 5, fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>
                    {reviewGuidance.nextAction}
                  </div>
                ) : null}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {chatTargetControl && onInjectChatContext ? chatTargetControl : null}
              {!activePullRequest && repoSlug && currentBranch && currentBranch !== 'main' ? (
                <PrimaryActionButton
                  icon={<GitPullRequest size={11} strokeWidth={2.2} />}
                  label="Create PR"
                  onClick={openBranchPullRequest}
                />
              ) : null}
              {activePullRequest && reviewGuidance.mergeAllowed ? (
                <PrimaryActionButton
                  icon={<GitMerge size={11} strokeWidth={2.2} />}
                  label={reviewActionLoading === 'merge' ? 'Merging...' : 'Merge PR'}
                  onClick={() => { void submitPullRequestAction('merge'); }}
                  disabled={reviewActionLoading !== null}
                  tone="success"
                  prominent
                />
              ) : null}
              {activePullRequest && !reviewGuidance.mergeAllowed && failedChecks.length > 0 && onInjectChatContext ? (
                <PrimaryActionButton
                  icon={<MessageSquare size={11} strokeWidth={2.2} />}
                  label={addedContextKeys[`checks:${activePullRequest.number}`] ? 'Checks added' : 'Add failed checks'}
                  onClick={addFailedChecksToChat}
                  disabled={Boolean(addedContextKeys[`checks:${activePullRequest.number}`])}
                />
              ) : null}
              {activePullRequest && !reviewGuidance.mergeAllowed && failedChecks.length === 0 && allCommentContexts.length > 0 && onInjectChatContext ? (
                <PrimaryActionButton
                  icon={<MessageSquare size={11} strokeWidth={2.2} />}
                  label={addedContextKeys[`comments:${activePullRequest.number}`] ? 'Comments added' : 'Add comments'}
                  onClick={addCommentsToChat}
                  disabled={Boolean(addedContextKeys[`comments:${activePullRequest.number}`])}
                />
              ) : null}
              {activePullRequest && !compactReview && repoSlug && onOpenPullRequest ? (
                <PrimaryActionButton
                  icon={<ArrowRight size={11} strokeWidth={2.2} />}
                  label="Deep review"
                  onClick={() => {
                    if (onDeepReviewPullRequest) {
                      onDeepReviewPullRequest(activePullRequest.number, repoSlug);
                      return;
                    }
                    onOpenPullRequest(activePullRequest.number, repoSlug);
                  }}
                  tone="neutral"
                />
              ) : null}
            </div>

            {reviewActionResult ? (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: 10,
                  background: reviewActionResult.type === 'success' ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                  color: reviewActionResult.type === 'success' ? '#15803d' : '#b91c1c',
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {reviewActionResult.message}
              </div>
            ) : null}
          </div>
        </ContextObjectCard>

        {!compactReview && !activePullRequest && scopedWorktrees.length > 0 ? scopedWorktrees.map((worktree) => {
          const tone = worktreeStateTone(worktree);
          return (
            <ContextObjectCard key={`${worktree.path}:${worktree.branch ?? 'detached'}`} itemKind="worktree" itemId={worktree.path}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <GitBranch size={14} style={{ color: tone.color, marginTop: 2, flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{worktree.branch ?? 'Detached worktree'}</div>
                    <span style={{ display: 'inline-flex', padding: '2px 7px', borderRadius: 999, background: tone.bg, color: tone.color, fontSize: 10, fontWeight: 700 }}>
                      {worktreeStateLabel(worktree)}
                    </span>
                  </div>
                  <div style={{ marginTop: 3, fontSize: 11, color: 'var(--t-text-muted)' }}>{worktree.path}</div>
                </div>
              </div>
            </ContextObjectCard>
          );
        }) : null}

        {!compactReview && !activePullRequest && snapshot.warnings && snapshot.warnings.length > 0 ? snapshot.warnings.map((warning, index) => (
          <ContextObjectCard key={warning} itemKind="warning" itemId={`warning-${index}`}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, color: '#92400e' }}>
              <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>{warning}</div>
            </div>
          </ContextObjectCard>
        )) : null}
      </ReviewSection>

      {/* ── Compact companion ─────────────────────────────────────────── */}
      {compactReview && activePullRequest ? (
        <ReviewSection
          title="Companion"
          actions={onExpandReviewRail ? (
            <ContextActionChip
              icon={<ChevronDown size={11} strokeWidth={2} />}
              label="Open review rail"
              onClick={onExpandReviewRail}
            />
          ) : undefined}
        >
          <ContextObjectCard itemKind="review-companion" itemId={`companion:${activePullRequest.number}`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>Checks</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>{compactChecksSummary}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>Comments</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>{compactCommentsSummary}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>Deploy</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>{compactDeploySummary}</span>
              </div>
            </div>
          </ContextObjectCard>
        </ReviewSection>
      ) : null}

      {/* ── Checks section ────────────────────────────────────────────── */}
      {!compactReview ? (
        <ReviewChecksSection
          expandedSection={expandedSection}
          onToggleSection={() => setExpandedSection((current) => current === 'checks' ? null : 'checks')}
          activePullRequest={activePullRequest}
          repoSlug={repoSlug}
          repo={repo}
          onInjectChatContext={onInjectChatContext}
          addedContextKeys={addedContextKeys}
          injectPayload={injectPayload}
          addFailedChecksToChat={addFailedChecksToChat}
          failedChecks={failedChecks}
          checks={checks}
          checksLoading={checksLoading}
          scopedChecks={scopedChecks}
          groupedChecks={groupedChecks}
          reviewBranch={reviewBranch}
          hoveredRunId={hoveredRunId}
          hoveredRun={hoveredRun}
          hoveredRunRect={hoveredRunRect}
          hoveredGroup={hoveredGroup}
          runDetail={runDetail}
          detailLoading={detailLoading}
          hoverCloseTimerRef={hoverCloseTimerRef}
          openRunHover={openRunHover}
          scheduleRunHoverClose={scheduleRunHoverClose}
          setHoveredRunRect={setHoveredRunRect}
        />
      ) : null}

      {/* ── Comments section ──────────────────────────────────────────── */}
      {!compactReview ? (
        <ReviewCommentsSection
          expandedSection={expandedSection}
          onToggleSection={() => setExpandedSection((current) => current === 'comments' ? null : 'comments')}
          activePullRequest={activePullRequest}
          repoSlug={repoSlug}
          onInjectChatContext={onInjectChatContext}
          addedContextKeys={addedContextKeys}
          injectPayload={injectPayload}
          addCommentsToChat={addCommentsToChat}
          commentsLoading={commentsLoading}
          prDetail={prDetail}
          issueComments={issueComments}
          reviewComments={reviewComments}
          inlineCommentsByPath={inlineCommentsByPath}
          allCommentContexts={allCommentContexts}
          repo={repo}
        />
      ) : null}

      {/* ── Deploy section ────────────────────────────────────────────── */}
      {!compactReview ? (
        <ReviewDeploySection
          expandedSection={expandedSection}
          onToggleSection={() => setExpandedSection((current) => current === 'deploy' ? null : 'deploy')}
          deploySummaryLabel={deploySummaryLabel}
          shouldShowDeployList={shouldShowDeployList}
          deployLoading={deployLoading}
          deployments={deployments}
        />
      ) : null}
    </div>
  );
});
