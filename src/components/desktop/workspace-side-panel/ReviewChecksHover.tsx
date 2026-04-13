'use client';

import { memo } from 'react';
import { ExternalLink, MessageSquare } from '../lucide-shims';
import type {
  WorkspaceReviewCheckRun,
  WorkspaceReviewCheckRunDetail,
  WorkflowRunGroup,
  WorkspaceSidePanelRepo,
  WorkspaceResolvedPullRequest,
  AgentPanelChatInjectionPayload,
} from './types';
import {
  workflowRunTone,
  formatAge,
  ContextActionChip,
  ContextIconButton,
  ReviewSection,
  ContextObjectCard,
  EmptySectionState,
} from './shared';
import { BlueGlassHoverCard, BlueGlassActionButton } from '../BlueGlassHoverCard';
import {
  formatCiCheckInjection,
} from '@/lib/chat/injection';

export const ReviewChecksHover = memo(function ReviewChecksHover({
  hoveredRun,
  hoveredRunRect,
  hoveredGroup,
  runDetail,
  detailLoading,
  hoverCloseTimerRef,
  scheduleRunHoverClose,
  activePullRequest,
  repoSlug,
  repo,
  onInjectChatContext,
  addedContextKeys,
  injectPayload,
}: {
  hoveredRun: WorkspaceReviewCheckRun | null;
  hoveredRunRect: DOMRect | null;
  hoveredGroup: WorkflowRunGroup | null;
  runDetail: WorkspaceReviewCheckRunDetail['run'] | null;
  detailLoading: boolean;
  hoverCloseTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  scheduleRunHoverClose: () => void;
  activePullRequest: WorkspaceResolvedPullRequest | null;
  repoSlug: string | null;
  repo: WorkspaceSidePanelRepo | null;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload, repo: WorkspaceSidePanelRepo | null) => void;
  addedContextKeys: Record<string, boolean>;
  injectPayload: (key: string, payload: AgentPanelChatInjectionPayload) => void;
}) {
  if (!hoveredRun || !hoveredRunRect) return null;

  return (
    <BlueGlassHoverCard
      eyebrow="Checks"
      title={hoveredGroup?.title ?? hoveredRun.displayTitle ?? hoveredRun.workflowName ?? 'Workflow run'}
      subtitle={hoveredGroup?.branch ?? hoveredRun.headBranch ?? repo?.branch ?? 'branch'}
      anchorRect={hoveredRunRect}
      interactive
      onMouseEnter={() => {
        if (hoverCloseTimerRef.current) {
          clearTimeout(hoverCloseTimerRef.current);
          hoverCloseTimerRef.current = null;
        }
      }}
      onMouseLeave={scheduleRunHoverClose}
      footer={(
        <>
          <div />
          {hoveredRun.url ? (
            <BlueGlassActionButton
              icon={<ExternalLink size={12} strokeWidth={2} />}
              label="Open Run"
              onClick={() => window.open(hoveredRun.url, '_blank', 'noopener,noreferrer')}
            />
          ) : null}
        </>
      )}
    >
      {!runDetail || detailLoading ? (
        <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Loading run details...</div>
      ) : (
        <>
          {hoveredGroup ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {hoveredGroup.runs.map((run) => {
                const tone = workflowRunTone(run);
                const key = `check:${run.databaseId}`;
                const isPassed = tone.label === 'Passing';
                return (
                  <div
                    key={run.databaseId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      borderRadius: 10,
                      background: 'var(--t-panel-hover)',
                    }}
                  >
                    <span style={{ color: tone.color, fontWeight: 700 }}>
                      {tone.label === 'Passing' ? '\u2713' : tone.label === 'Pending' ? '\u25CB' : '\u2717'}
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>
                        {run.workflowName || 'CI'}
                      </div>
                      <div style={{ marginTop: 2, fontSize: 10, color: tone.color }}>{tone.label}</div>
                    </div>
                    {!isPassed && activePullRequest?.number && onInjectChatContext ? (
                      <ContextIconButton
                        icon={<MessageSquare size={11} strokeWidth={2} />}
                        label={addedContextKeys[key] ? 'Added to chat' : 'Add to chat'}
                        onClick={() => injectPayload(
                          key,
                          formatCiCheckInjection({
                            prNumber: activePullRequest.number,
                            repo: repoSlug ?? undefined,
                            name: run.workflowName || run.displayTitle || 'Workflow',
                            status: run.status,
                            conclusion: run.conclusion,
                            detailsUrl: run.url,
                            startedAt: run.createdAt,
                            completedAt: run.updatedAt,
                          }),
                        )}
                        disabled={Boolean(addedContextKeys[key])}
                      />
                    ) : null}
                    {run.url ? (
                      <ContextIconButton
                        icon={<ExternalLink size={11} strokeWidth={2} />}
                        label="Open run"
                        onClick={() => window.open(run.url, '_blank', 'noopener,noreferrer')}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {runDetail.jobs && runDetail.jobs.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t-text-muted)' }}>
                Jobs
              </div>
              {runDetail.jobs.slice(0, 5).map((job) => {
                const tone = workflowRunTone(job);
                return (
                  <div
                    key={job.databaseId}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 10,
                      background: 'var(--t-panel-hover)',
                      fontSize: 11,
                      color: 'var(--t-text-secondary)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ color: tone.color, fontWeight: 700 }}>{tone.label === 'Passing' ? '\u2713' : tone.label === 'Pending' ? '\u25CB' : '\u2717'}</span>
                      <div style={{ fontWeight: 700 }}>{job.name}</div>
                      <span style={{ color: tone.color, fontSize: 10 }}>{tone.label}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          {runDetail.annotations && runDetail.annotations.length > 0 ? (
            <div
              style={{
                fontSize: 11,
                lineHeight: 1.5,
                color: 'var(--t-text-secondary)',
                padding: '7px 8px',
                borderRadius: 10,
                background: 'var(--t-panel-hover)',
              }}
            >
              {runDetail.annotations[0]?.path}
              {runDetail.annotations[0]?.startLine ? `:${runDetail.annotations[0].startLine}` : ''}
              {' \u2022 '}
              {runDetail.annotations[0]?.message || runDetail.annotations[0]?.title || runDetail.annotations[0]?.rawDetails}
            </div>
          ) : null}
        </>
      )}
    </BlueGlassHoverCard>
  );
});

// ── Checks Section (full section with hover card) ────────────────────
export const ReviewChecksSection = memo(function ReviewChecksSection({
  expandedSection,
  onToggleSection,
  activePullRequest,
  repoSlug,
  repo,
  onInjectChatContext,
  addedContextKeys,
  injectPayload,
  addFailedChecksToChat,
  failedChecks,
  checks,
  checksLoading,
  scopedChecks,
  groupedChecks,
  reviewBranch,
  hoveredRunId,
  hoveredRun,
  hoveredRunRect,
  hoveredGroup,
  runDetail,
  detailLoading,
  hoverCloseTimerRef,
  openRunHover,
  scheduleRunHoverClose,
  setHoveredRunRect,
}: {
  expandedSection: 'checks' | 'comments' | 'deploy' | null;
  onToggleSection: () => void;
  activePullRequest: WorkspaceResolvedPullRequest | null;
  repoSlug: string | null;
  repo: WorkspaceSidePanelRepo | null;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload, repo: WorkspaceSidePanelRepo | null) => void;
  addedContextKeys: Record<string, boolean>;
  injectPayload: (key: string, payload: AgentPanelChatInjectionPayload) => void;
  addFailedChecksToChat: () => void;
  failedChecks: WorkspaceReviewCheckRun[];
  checks: WorkspaceReviewCheckRun[];
  checksLoading: boolean;
  scopedChecks: WorkspaceReviewCheckRun[];
  groupedChecks: WorkflowRunGroup[];
  reviewBranch: string | null;
  hoveredRunId: number | null;
  hoveredRun: WorkspaceReviewCheckRun | null;
  hoveredRunRect: DOMRect | null;
  hoveredGroup: WorkflowRunGroup | null;
  runDetail: WorkspaceReviewCheckRunDetail['run'] | null;
  detailLoading: boolean;
  hoverCloseTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  openRunHover: (runId: number, rect: DOMRect) => void;
  scheduleRunHoverClose: () => void;
  setHoveredRunRect: React.Dispatch<React.SetStateAction<DOMRect | null>>;
}) {
  return (
    <ReviewSection
      title={activePullRequest ? 'PR Checks' : 'Checks'}
      collapsible
      open={expandedSection === 'checks'}
      onToggle={onToggleSection}
      actions={
        <>
          {failedChecks.length > 0 && activePullRequest?.number && onInjectChatContext ? (
            <ContextActionChip
              icon={<MessageSquare size={11} strokeWidth={2} />}
              label={addedContextKeys[`checks:${activePullRequest.number}`] ? 'Added' : 'Add failed'}
              onClick={addFailedChecksToChat}
              disabled={Boolean(addedContextKeys[`checks:${activePullRequest.number}`])}
            />
          ) : null}
        </>
      }
    >
      {checksLoading && scopedChecks.length === 0 ? (
        <EmptySectionState>Loading CI state...</EmptySectionState>
      ) : scopedChecks.length === 0 ? (
        <EmptySectionState>
          {activePullRequest
            ? (checks.length > 0
              ? 'No CI runs are attached to this PR branch yet. Recent repo runs exist on other branches.'
              : 'No CI runs are attached to this PR yet.')
            : (reviewBranch ? `No recent CI runs for ${reviewBranch}.` : 'No recent CI runs yet.')}
        </EmptySectionState>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ padding: '2px 2px 0', fontSize: 10, fontWeight: 700, color: 'var(--t-text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Recent runs
            </div>
            {groupedChecks.slice(0, 6).map((group) => {
              const failingCount = group.runs.filter((run) => workflowRunTone(run).label === 'Failing').length;
              const pendingCount = group.runs.filter((run) => workflowRunTone(run).label === 'Pending').length;
              const passingCount = group.runs.filter((run) => workflowRunTone(run).label === 'Passing').length;
              const primaryRun = group.runs.find((run) => workflowRunTone(run).label === 'Failing')
                ?? group.runs.find((run) => workflowRunTone(run).label === 'Pending')
                ?? group.runs[0];
              return (
                <ContextObjectCard
                  key={group.key}
                  itemKind="check-group"
                  itemId={group.key}
                  style={{ padding: '6px 8px', borderRadius: 9 }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(event) => openRunHover(primaryRun.databaseId, (event.currentTarget as HTMLDivElement).getBoundingClientRect())}
                    onMouseEnter={(event) => openRunHover(primaryRun.databaseId, (event.currentTarget as HTMLDivElement).getBoundingClientRect())}
                    onMouseMove={(event) => {
                      if (hoveredRunId === primaryRun.databaseId) {
                        setHoveredRunRect((event.currentTarget as HTMLDivElement).getBoundingClientRect());
                      }
                    }}
                    onMouseLeave={scheduleRunHoverClose}
                    onFocus={(event) => openRunHover(primaryRun.databaseId, (event.currentTarget as HTMLDivElement).getBoundingClientRect())}
                    onBlur={scheduleRunHoverClose}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openRunHover(primaryRun.databaseId, (event.currentTarget as HTMLDivElement).getBoundingClientRect());
                      }
                    }}
                    style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, cursor: 'pointer' }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)' }}>{group.title}</div>
                      <div style={{ marginTop: 3, fontSize: 10, color: 'var(--t-text-muted)', display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                        <span>{group.branch}</span>
                        <span>{formatAge(group.updatedAt || group.createdAt)}</span>
                        <span style={{ color: 'var(--t-text-faint)' }}>
                          {[
                            failingCount > 0 ? `${failingCount} fail` : null,
                            pendingCount > 0 ? `${pendingCount} pending` : null,
                            passingCount > 0 ? `${passingCount} pass` : null,
                          ].filter(Boolean).join(' \u2022 ')}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {primaryRun?.url ? (
                        <ContextIconButton
                          icon={<ExternalLink size={11} strokeWidth={2} />}
                          label="Open run"
                          onClick={() => {
                            window.open(primaryRun.url, '_blank', 'noopener,noreferrer');
                          }}
                        />
                      ) : null}
                    </div>
                  </div>
                </ContextObjectCard>
              );
            })}
          </div>
        </>
      )}
      <ReviewChecksHover
        hoveredRun={hoveredRun}
        hoveredRunRect={hoveredRunRect}
        hoveredGroup={hoveredGroup}
        runDetail={runDetail}
        detailLoading={detailLoading}
        hoverCloseTimerRef={hoverCloseTimerRef}
        scheduleRunHoverClose={scheduleRunHoverClose}
        activePullRequest={activePullRequest}
        repoSlug={repoSlug}
        repo={repo}
        onInjectChatContext={onInjectChatContext}
        addedContextKeys={addedContextKeys}
        injectPayload={injectPayload}
      />
    </ReviewSection>
  );
});
