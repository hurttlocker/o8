import type { RepoReadinessState } from '@/lib/repos/types';

export type WorkflowStageKey =
  | 'queued'
  | 'working'
  | 'reviewing'
  | 'waiting'
  | 'blocked'
  | 'merge_ready'
  | 'ready';

export interface WorkflowStageBadge {
  key: WorkflowStageKey;
  label: string;
  color: string;
  background: string;
}

export interface WorkflowStageInput {
  autoQueued?: boolean;
  runtimeStatus?: string | null;
  workspaceStatus?: string | null;
  lifecycleState?: string | null;
  latestText?: string | null;
  lastActivityAt?: number | null;
  hasMessages?: boolean;
  readinessState?: RepoReadinessState | null;
  prState?: string | null;
  failedChecks?: number;
  pendingChecks?: number;
  requestedChanges?: number;
}

export interface WorkflowStageGuidanceInput extends WorkflowStageInput {
  stage?: WorkflowStageBadge | null;
  readinessSummary?: string | null;
  readinessNextAction?: string | null;
  approvedCount?: number;
}

export interface WorkflowStageGuidance {
  stage: WorkflowStageBadge | null;
  detail: string;
  nextAction?: string;
  mergeAllowed: boolean;
  mergeDetail: string;
  archiveDetail: string;
  archiveUnavailableReason: string;
  resumeDetail: string;
  resumeUnavailableReason: string;
}

const workflowStageRank: Record<WorkflowStageKey, number> = {
  blocked: 6,
  merge_ready: 5,
  waiting: 4,
  reviewing: 3,
  working: 2,
  queued: 1,
  ready: 0,
};

export function workflowBadge(key: WorkflowStageKey): WorkflowStageBadge {
  switch (key) {
    case 'queued':
      return { key, label: 'Queued', color: '#d97706', background: 'rgba(245, 158, 11, 0.12)' };
    case 'working':
      return { key, label: 'Working', color: '#16a34a', background: 'rgba(34, 197, 94, 0.12)' };
    case 'reviewing':
      return { key, label: 'Reviewing', color: '#7c3aed', background: 'rgba(124, 58, 237, 0.12)' };
    case 'waiting':
      return { key, label: 'Waiting', color: '#64748b', background: 'rgba(148, 163, 184, 0.12)' };
    case 'blocked':
      return { key, label: 'Blocked', color: '#dc2626', background: 'rgba(239, 68, 68, 0.12)' };
    case 'merge_ready':
      return { key, label: 'Merge ready', color: '#15803d', background: 'rgba(34, 197, 94, 0.14)' };
    default:
      return { key, label: 'Ready', color: '#2563eb', background: 'rgba(37, 99, 235, 0.12)' };
  }
}

export function deriveWorkflowStage(input: WorkflowStageInput): WorkflowStageBadge | null {
  const latestText = input.latestText?.toLowerCase() ?? '';
  const ageMs = input.lastActivityAt ? Date.now() - input.lastActivityAt : Number.POSITIVE_INFINITY;
  const prState = input.prState?.toLowerCase() ?? '';
  const failedChecks = input.failedChecks ?? 0;
  const pendingChecks = input.pendingChecks ?? 0;
  const requestedChanges = input.requestedChanges ?? 0;

  if (input.autoQueued && !input.hasMessages) {
    return workflowBadge('queued');
  }
  if (
    input.lifecycleState === 'completed'
    || input.workspaceStatus === 'done'
  ) {
    return workflowBadge('ready');
  }
  if (
    input.lifecycleState === 'stalled'
  ) {
    return workflowBadge('blocked');
  }
  if (
    input.lifecycleState === 'failed'
    || input.runtimeStatus === 'failed'
    || input.runtimeStatus === 'blocked'
    || input.readinessState === 'blocked'
    || /(blocked|unable|failed|error|not ready|missing|broken)/.test(latestText)
  ) {
    return workflowBadge('blocked');
  }
  if (prState === 'open') {
    if (requestedChanges > 0 || failedChecks > 0) {
      return workflowBadge('blocked');
    }
    if (pendingChecks > 0) {
      return workflowBadge('waiting');
    }
    if (input.readinessState === 'needs_setup') {
      return workflowBadge('waiting');
    }
    return workflowBadge('merge_ready');
  }
  if (
    input.workspaceStatus === 'in_review'
    || input.runtimeStatus === 'reviewing'
  ) {
    if (/(ready to merge|ready for merge|merge ready)/.test(latestText)) {
      return workflowBadge('merge_ready');
    }
    return workflowBadge('reviewing');
  }
  if (/(ready to merge|ready for merge|merge ready)/.test(latestText)) {
    return workflowBadge('merge_ready');
  }
  if (/(ready for review|review pending)/.test(latestText)) {
    return workflowBadge('reviewing');
  }
  if (/(completed|complete\b|done\b|no file edits|ready for resume)/.test(latestText)) {
    return workflowBadge('ready');
  }
  if (input.runtimeStatus === 'running' || (input.hasMessages && ageMs < 20_000)) {
    return workflowBadge('working');
  }
  if (input.readinessState === 'needs_setup' || input.runtimeStatus === 'waiting' || input.hasMessages) {
    return workflowBadge('waiting');
  }
  return null;
}

export function pickDominantWorkflowStage(stages: Array<WorkflowStageBadge | null | undefined>): WorkflowStageBadge | null {
  let winner: WorkflowStageBadge | null = null;
  for (const stage of stages) {
    if (!stage) continue;
    if (!winner || workflowStageRank[stage.key] > workflowStageRank[winner.key]) {
      winner = stage;
    }
  }
  return winner;
}

export function describeWorkflowStage(input: WorkflowStageGuidanceInput): WorkflowStageGuidance {
  const stage = input.stage ?? deriveWorkflowStage(input);
  const readinessSummary = input.readinessSummary?.trim() || null;
  const readinessNextAction = input.readinessNextAction?.trim() || null;
  const failedChecks = input.failedChecks ?? 0;
  const pendingChecks = input.pendingChecks ?? 0;
  const requestedChanges = input.requestedChanges ?? 0;
  const approvedCount = input.approvedCount ?? 0;

  if (!stage) {
    return {
      stage: null,
      detail: readinessSummary ?? 'Workspace state is available, but the next workflow step is not classified yet.',
      nextAction: readinessNextAction ?? undefined,
      mergeAllowed: false,
      mergeDetail: 'Review the current state before merging.',
      archiveDetail: 'Archive remains unavailable until this workspace has a clearer workflow state.',
      archiveUnavailableReason: 'Workspace-level archive is not available yet.',
      resumeDetail: 'Use the live session surfaces to continue this work.',
      resumeUnavailableReason: 'Workspace-level resume is not available yet.',
    };
  }

  switch (stage.key) {
    case 'blocked':
      return {
        stage,
        detail: requestedChanges > 0
          ? `${requestedChanges} review${requestedChanges === 1 ? '' : 's'} requested changes before this can move forward.`
          : failedChecks > 0
            ? `${failedChecks} check${failedChecks === 1 ? '' : 's'} still failing on this path.`
            : readinessSummary ?? 'Validation is blocked on this workspace.',
        nextAction: requestedChanges > 0
          ? 'Address the requested changes and rerun validation before asking for review again.'
          : failedChecks > 0
            ? 'Fix the failing checks or rerun validation before treating this branch as reviewable.'
            : readinessNextAction ?? 'Restore local readiness before trusting the next review or merge step.',
        mergeAllowed: false,
        mergeDetail: 'Merge stays blocked until the failing review, validation, or local readiness issue is resolved.',
        archiveDetail: 'Archive is not a safe move while this workspace is blocked.',
        archiveUnavailableReason: 'Archive is unavailable while the workspace is blocked.',
        resumeDetail: 'Resume the live session after you clear the blocker.',
        resumeUnavailableReason: 'Workspace-level resume is unavailable while this lane is blocked.',
      };
    case 'waiting':
      return {
        stage,
        detail: pendingChecks > 0
          ? `${pendingChecks} check${pendingChecks === 1 ? '' : 's'} still running or unresolved.`
          : readinessSummary ?? 'This lane is waiting on setup, validation, or a human gate.',
        nextAction: pendingChecks > 0
          ? 'Let the checks finish, then reopen review with the latest results.'
          : readinessNextAction ?? 'Complete the pending setup or human validation step before merge.',
        mergeAllowed: false,
        mergeDetail: 'Merge is waiting on a pending setup, validation, or human gate.',
        archiveDetail: 'Archive stays unavailable while this workspace is still waiting on setup or review.',
        archiveUnavailableReason: 'Archive is unavailable while the workspace is waiting on setup or review.',
        resumeDetail: 'Use the active workspace session once the blocking step is resolved.',
        resumeUnavailableReason: 'Workspace-level resume is unavailable while this lane is waiting on the next step.',
      };
    case 'merge_ready':
      return {
        stage,
        detail: approvedCount > 0
          ? `Checks are green and ${approvedCount} review${approvedCount === 1 ? '' : 's'} approved this branch.`
          : 'Checks are green. This branch is waiting on a final human merge decision.',
        nextAction: 'Merge the pull request or leave a final review note before closing the loop.',
        mergeAllowed: true,
        mergeDetail: 'Everything needed for merge is green. Finish the human merge step.',
        archiveDetail: 'Archive stays unavailable until the merge or handoff is completed.',
        archiveUnavailableReason: 'Archive is unavailable until the merge-ready branch is handed off cleanly.',
        resumeDetail: 'If you need one more turn, resume the live session from the workspace tab instead of archiving the lane.',
        resumeUnavailableReason: 'Workspace-level resume is not available yet; use the live session tab for any final turn.',
      };
    case 'reviewing':
      return {
        stage,
        detail: 'The branch is ready for human review, but it is not merge-ready yet.',
        nextAction: 'Review the diff, comments, and checks before deciding whether to approve or request changes.',
        mergeAllowed: false,
        mergeDetail: 'Merge is not available yet because review is still in progress.',
        archiveDetail: 'Archive stays unavailable while human review is still active.',
        archiveUnavailableReason: 'Archive is unavailable while the workspace is under review.',
        resumeDetail: 'Resume the live session if review feedback requires another coding pass.',
        resumeUnavailableReason: 'Workspace-level resume is not available yet; use the live session surface instead.',
      };
    case 'working':
      return {
        stage,
        detail: 'The workspace is still actively working through the current task.',
        nextAction: 'Let the run finish or steer the live session if the task needs course correction.',
        mergeAllowed: false,
        mergeDetail: 'Merge is unavailable while the agent is still working.',
        archiveDetail: 'Archive stays unavailable while the workspace is still running.',
        archiveUnavailableReason: 'Archive is unavailable while the workspace is actively working.',
        resumeDetail: 'Resume is unnecessary while the current session is still active.',
        resumeUnavailableReason: 'Use the active session instead of a workspace-level resume.',
      };
    case 'queued':
      return {
        stage,
        detail: 'The workspace task is queued and waiting for the runtime to begin.',
        nextAction: 'Wait for the runtime to start before steering or reviewing this lane.',
        mergeAllowed: false,
        mergeDetail: 'Merge is unavailable until the queued task actually runs and produces reviewable output.',
        archiveDetail: 'Archive stays unavailable while a task is still queued to start.',
        archiveUnavailableReason: 'Archive is unavailable while a queued task has not started yet.',
        resumeDetail: 'Wait for the queued task to start, then use the live session surface.',
        resumeUnavailableReason: 'Workspace-level resume is unavailable while the task is only queued.',
      };
    case 'ready':
    default:
      return {
        stage,
        detail: readinessSummary ?? 'This workspace is ready for the next task.',
        nextAction: readinessNextAction ?? 'Launch the next task or move this lane toward archive once workspace archive is implemented.',
        mergeAllowed: false,
        mergeDetail: 'There is nothing waiting to merge from this lane right now.',
        archiveDetail: 'Archive will eventually make sense here once workspace-level archive is implemented.',
        archiveUnavailableReason: 'Workspace-level archive is not available yet.',
        resumeDetail: 'Use the live session surfaces if you need to continue from the latest ready state.',
        resumeUnavailableReason: 'Workspace-level resume is not available yet.',
      };
  }
}
