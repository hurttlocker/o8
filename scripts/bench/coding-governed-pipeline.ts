import { getApproval } from '../../src/lib/approvals/store';
import {
  assessDurableApprovedReview,
  type DurableReviewAssessment,
} from '../../src/lib/lane/durable-review-approval';
import type { LaneStatus } from '../../src/lib/lane/types';
import type { OrchestratorPacketStatus } from '../../src/lib/orchestrator/types';
import {
  TurnStatus,
  classifyArmStatus,
  type ArmClassification,
  type ArmErrorReceipt,
} from './coding-arm-outcome';
import {
  readDurablePacketState,
  reconcileArmWithDurableState,
  type DurablePacketState,
  type DurableReconciliationReceipt,
} from './coding-durable-reconciliation';
import {
  parseEndToEndJson,
  runEndToEndCommand,
  type EndToEndCommandReceipt,
} from './coding-end-to-end-command';
import {
  governedConvergenceAction,
  governedPipelineTerminalStatus,
  refixFeedback,
  reviewAttemptFromStatus,
  reviewAttemptKey,
  type GovernedPipelineOutcome,
  type GovernedReviewAttemptReceipt,
  type PacketDiffReceipt,
} from './coding-end-to-end-review';

export const GOVERNED_TIMEOUT_SECONDS = 7_200;
export const MAX_GOVERNED_REVIEW_ATTEMPTS = 3;

const GOVERNED_WAIT_SLICE_MS = 60_000;
const GOVERNED_REVIEW_POLL_MS = 5_000;
const MAX_DIFF_BYTES = 32 * 1024 * 1024;

interface ReviewStatus {
  approved?: unknown;
  summary?: unknown;
  recordedAt?: unknown;
  reviewedHeadSha?: unknown;
  auditApprovalId?: unknown;
}

interface MissionWaitPacket {
  id?: unknown;
  status?: unknown;
  blockedReason?: unknown;
  lane?: {
    laneId?: unknown;
    branch?: unknown;
    repoPath?: unknown;
    sessionKey?: unknown;
    status?: unknown;
  } | null;
  review?: ReviewStatus | null;
}

interface MissionWaitPayload {
  wakeReason?: unknown;
  status?: {
    cost?: unknown;
    packets?: MissionWaitPacket[];
    agents?: Array<{
      packetId?: unknown;
      laneId?: unknown;
      sessionKey?: unknown;
      branch?: unknown;
      repoPath?: unknown;
    }>;
  };
}

export interface GovernedMergePreviewReceipt {
  packetId: string | null;
  wouldMerge: boolean | null;
  blockers: string[];
  branch: string | null;
}

interface MergePreviewPayload {
  preview?: {
    packetId?: unknown;
    wouldMerge?: unknown;
    blockers?: unknown;
    branch?: unknown;
  };
}

export interface GovernedPipelineDriveResult {
  classification: ArmClassification;
  shippedDiff: string;
  waitCommands: EndToEndCommandReceipt[];
  statusPolls: number;
  finalStatusCommand: EndToEndCommandReceipt | null;
  finalStatus: unknown;
  cost: unknown;
  laneId: string | null;
  sessionKey: string | null;
  branch: string | null;
  worktree: string | null;
  durableReview: DurableReviewAssessment | null;
  pipelineOutcome: GovernedPipelineOutcome;
  pipelineFailureReason: string | null;
  packetDiffCommand: EndToEndCommandReceipt | null;
  mergePreviewCommand: EndToEndCommandReceipt | null;
  mergePreview: GovernedMergePreviewReceipt | null;
  diffHeadSha: string | null;
  diffBase: string | null;
  diffTruncated: boolean;
  durableReconciliation: DurableReconciliationReceipt | null;
  reviewAttempts: GovernedReviewAttemptReceipt[];
  commandsPassed: boolean;
}

function waitBeforeReviewProbe(deadline: number): void {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    Math.min(GOVERNED_REVIEW_POLL_MS, remaining),
  );
}

function missionWaitArgs(missionId: string, packetId: string, timeoutMs: number): string[] {
  return [
    'mission', 'wait',
    '--mission', missionId,
    '--packet', packetId,
    '--timeout', `${timeoutMs}ms`,
    '--poll', '3000',
  ];
}

function parseMergePreview(text: string): GovernedMergePreviewReceipt {
  const payload = parseEndToEndJson<MergePreviewPayload>(text, 'o8 packet merge-preview');
  const preview = payload.preview;
  if (!preview || typeof preview.wouldMerge !== 'boolean') {
    throw new Error('o8 packet merge-preview returned an invalid response');
  }
  return {
    packetId: typeof preview.packetId === 'string' ? preview.packetId : null,
    wouldMerge: preview.wouldMerge,
    blockers: Array.isArray(preview.blockers)
      ? preview.blockers.filter((blocker): blocker is string => typeof blocker === 'string')
      : [],
    branch: typeof preview.branch === 'string' ? preview.branch : null,
  };
}

function laneStatus(value: unknown): LaneStatus | null {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'idle':
    case 'launching':
    case 'running':
    case 'paused':
    case 'awaiting_input':
    case 'awaiting_orchestrator':
    case 'awaiting_human':
    case 'recovering':
    case 'reviewing':
    case 'merging':
    case 'failed':
    case 'completed':
    case 'archived':
      return value;
    default:
      return null;
  }
}

function packetStatus(value: unknown): OrchestratorPacketStatus | null {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'draft':
    case 'queued':
    case 'launching':
    case 'idle':
    case 'running':
    case 'awaiting_review':
    case 'recovering':
    case 'failed':
    case 'blocked':
    case 'released':
    case 'archived':
      return value;
    default:
      return null;
  }
}

async function assessDurableReview(input: {
  durable: Pick<DurablePacketState, 'laneId' | 'sessionKey' | 'worktreePath'>;
  packetId: string;
  repoRoot: string;
}): Promise<DurableReviewAssessment | null> {
  if (!input.durable.laneId || !input.durable.worktreePath) return null;
  return assessDurableApprovedReview({
    id: input.durable.laneId,
    packetId: input.packetId,
    sessionKey: input.durable.sessionKey,
    worktreePath: input.durable.worktreePath,
    repoPath: input.repoRoot,
    baseBranch: 'main',
    runtime: 'codex',
  });
}

export async function driveGovernedPipeline(input: {
  repoRoot: string;
  o8CliPath: string;
  base: string;
  missionId: string | null;
  packetId: string | null;
  create: EndToEndCommandReceipt;
  dispatch: EndToEndCommandReceipt;
  initialErrors: ArmErrorReceipt[];
}): Promise<GovernedPipelineDriveResult> {
  const streamErrors = [...input.initialErrors];
  const waitCommands: EndToEndCommandReceipt[] = [];
  const reviewAttempts: GovernedReviewAttemptReceipt[] = [];
  const observedReviewKeys = new Set<string>();
  let finalStatusCommand: EndToEndCommandReceipt | null = null;
  let finalStatus: unknown = null;
  let cost: unknown = null;
  let laneId: string | null = null;
  let sessionKey: string | null = null;
  let branch: string | null = null;
  let worktree: string | null = null;
  let durableReview: DurableReviewAssessment | null = null;
  let pipelineOutcome: GovernedPipelineOutcome = null;
  let pipelineFailureReason: string | null = null;
  let packetDiffCommand: EndToEndCommandReceipt | null = null;
  let mergePreviewCommand: EndToEndCommandReceipt | null = null;
  let mergePreview: GovernedMergePreviewReceipt | null = null;
  let diffHeadSha: string | null = null;
  let diffBase: string | null = null;
  let diffTruncated = false;
  let shippedDiff = '';
  let readCommandsPassed = true;
  let lastPacketStatus: OrchestratorPacketStatus | null = null;
  let lastLaneStatus: LaneStatus | null = null;

  const deadline = Date.now() + GOVERNED_TIMEOUT_SECONDS * 1_000;
  while (
    input.missionId
    && input.packetId
    && input.dispatch.status === 0
    && Date.now() < deadline
  ) {
    if (lastLaneStatus === 'reviewing') waitBeforeReviewProbe(deadline);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const waitMs = Math.min(GOVERNED_WAIT_SLICE_MS, remaining);
    const wait = runEndToEndCommand(
      input.o8CliPath,
      missionWaitArgs(input.missionId, input.packetId, waitMs),
      { cwd: input.repoRoot, timeoutMs: waitMs + 90_000 },
    );
    waitCommands.push(wait.receipt);
    finalStatusCommand = wait.receipt;
    if (wait.receipt.status !== 0) {
      streamErrors.push({ message: 'o8 mission wait failed', willRetry: false });
      readCommandsPassed = false;
      pipelineOutcome = 'stream-lost';
      pipelineFailureReason = 'mission wait could not observe the governed pipeline';
      break;
    }

    let waitPayload: MissionWaitPayload;
    try {
      waitPayload = parseEndToEndJson<MissionWaitPayload>(wait.stdout, 'o8 mission wait');
    } catch (error) {
      streamErrors.push({
        message: error instanceof Error ? error.message : String(error),
        willRetry: false,
      });
      readCommandsPassed = false;
      pipelineOutcome = 'stream-lost';
      pipelineFailureReason = 'mission wait returned unreadable pipeline state';
      break;
    }

    finalStatus = waitPayload.status ?? null;
    cost = waitPayload.status?.cost ?? null;
    const packet = waitPayload.status?.packets?.find((candidate) => candidate.id === input.packetId);
    if (!packet) {
      streamErrors.push({ message: 'mission wait did not return the governed packet', willRetry: false });
      readCommandsPassed = false;
      pipelineOutcome = 'stream-lost';
      pipelineFailureReason = 'mission wait lost the governed packet';
      break;
    }
    lastPacketStatus = packetStatus(packet.status);
    lastLaneStatus = laneStatus(packet.lane?.status);
    laneId = typeof packet.lane?.laneId === 'string' ? packet.lane.laneId : laneId;
    sessionKey = typeof packet.lane?.sessionKey === 'string' ? packet.lane.sessionKey : sessionKey;
    branch = typeof packet.lane?.branch === 'string' ? packet.lane.branch : branch;
    worktree = typeof packet.lane?.repoPath === 'string' ? packet.lane.repoPath : worktree;
    const agent = waitPayload.status?.agents?.find((candidate) => (
      candidate.packetId === input.packetId || (laneId && candidate.laneId === laneId)
    ));
    sessionKey = typeof agent?.sessionKey === 'string' ? agent.sessionKey : sessionKey;
    branch = typeof agent?.branch === 'string' ? agent.branch : branch;
    worktree = typeof agent?.repoPath === 'string' ? agent.repoPath : worktree;

    const durableSnapshot = readDurablePacketState({
      packetId: input.packetId,
      expectedBase: input.base,
      completionBoundary: 'governed-review',
      includeWorktreeDiff: false,
    });
    laneId = durableSnapshot.laneId ?? laneId;
    sessionKey = durableSnapshot.sessionKey ?? sessionKey;
    branch = durableSnapshot.branch ?? branch;
    worktree = durableSnapshot.worktreePath ?? worktree;
    lastLaneStatus = laneStatus(durableSnapshot.laneStatus) ?? lastLaneStatus;

    const review = durableSnapshot.latestReview ?? packet.review ?? null;
    const reviewKey = review ? reviewAttemptKey(review) : null;
    if (review && reviewKey && !observedReviewKeys.has(reviewKey)) {
      observedReviewKeys.add(reviewKey);
      reviewAttempts.push(reviewAttemptFromStatus(reviewAttempts.length + 1, review));
    }
    const currentAttempt = reviewKey
      ? reviewAttempts.find((attempt) => attempt.approvalId === reviewKey)
        ?? reviewAttempts.at(-1)
        ?? null
      : null;

    if (laneId && worktree) {
      durableReview = await assessDurableApprovedReview({
        id: laneId,
        packetId: input.packetId,
        sessionKey,
        worktreePath: worktree,
        repoPath: input.repoRoot,
        baseBranch: 'main',
        runtime: 'codex',
      });
      if (currentAttempt) currentAttempt.durableAssessment = durableReview;
    }

    const reviewApproved = review?.approved === true
      ? true
      : review?.approved === false
        ? false
        : null;
    const convergenceAction = governedConvergenceAction({
      packetStatus: lastPacketStatus,
      laneStatus: lastLaneStatus,
      reviewApproved,
      durableReviewApproved: durableReview?.approved === true,
      reviewTurnActive: durableSnapshot.activeReviewTurnIds.length > 0,
      reviewInvalidated: durableSnapshot.reviewInvalidatedAfterLatest,
    });

    if (convergenceAction === 'capture-approved' && laneId && worktree) {
      const previewResult = runEndToEndCommand(
        input.o8CliPath,
        ['packet', 'merge-preview', '--packet', input.packetId],
        { cwd: input.repoRoot, timeoutMs: 5 * 60_000 },
      );
      mergePreviewCommand = previewResult.receipt;
      if (previewResult.receipt.status !== 0) {
        streamErrors.push({ message: 'packet merge preview failed', willRetry: false });
        readCommandsPassed = false;
        pipelineOutcome = 'stream-lost';
        pipelineFailureReason = 'review settled but merge preview could not be observed';
        break;
      }
      try {
        mergePreview = parseMergePreview(previewResult.stdout);
      } catch (error) {
        streamErrors.push({
          message: error instanceof Error ? error.message : String(error),
          willRetry: false,
        });
        readCommandsPassed = false;
        pipelineOutcome = 'stream-lost';
        pipelineFailureReason = 'packet merge preview returned unreadable state';
        break;
      }

      const diffResult = runEndToEndCommand(
        input.o8CliPath,
        ['packet', 'diff', input.packetId, '--max-bytes', String(MAX_DIFF_BYTES)],
        { cwd: input.repoRoot, timeoutMs: 60_000 },
      );
      packetDiffCommand = diffResult.receipt;
      if (diffResult.receipt.status !== 0) {
        streamErrors.push({ message: 'review-approved diff could not be read', willRetry: false });
        readCommandsPassed = false;
        pipelineOutcome = 'stream-lost';
        pipelineFailureReason = 'review settled but its diff could not be observed';
        break;
      }

      let diffResultPayload: PacketDiffReceipt;
      try {
        diffResultPayload = parseEndToEndJson<PacketDiffReceipt>(diffResult.stdout, 'o8 packet diff');
      } catch (error) {
        streamErrors.push({
          message: error instanceof Error ? error.message : String(error),
          willRetry: false,
        });
        readCommandsPassed = false;
        pipelineOutcome = 'stream-lost';
        pipelineFailureReason = 'review-approved diff returned unreadable state';
        break;
      }

      const postDiffAssessment = await assessDurableApprovedReview({
        id: laneId,
        packetId: input.packetId,
        sessionKey,
        worktreePath: worktree,
        repoPath: input.repoRoot,
        baseBranch: 'main',
        runtime: 'codex',
      });
      durableReview = postDiffAssessment;
      if (currentAttempt) currentAttempt.durableAssessment = postDiffAssessment;
      const capturedHead = typeof diffResultPayload.headSha === 'string'
        ? diffResultPayload.headSha
        : null;
      const approvedRecord = postDiffAssessment.approvalId
        ? getApproval(postDiffAssessment.approvalId)
        : null;
      const approvedHead = typeof approvedRecord?.args?.reviewedHeadSha === 'string'
        ? approvedRecord.args.reviewedHeadSha
        : approvedRecord?.metadata?.['Reviewed HEAD'] ?? null;
      const postDiffDurable = readDurablePacketState({
        packetId: input.packetId,
        expectedBase: input.base,
        completionBoundary: 'governed-review',
        includeWorktreeDiff: false,
      });
      const latestReviewMatches = postDiffDurable.latestReview?.approved === true
        && postDiffDurable.latestReview.auditApprovalId === postDiffAssessment.approvalId
        && postDiffDurable.latestReview.reviewedHeadSha === capturedHead;
      const laneStillSettled = postDiffDurable.laneStatus === 'reviewing'
        && postDiffDurable.activeReviewTurnIds.length === 0
        && !postDiffDurable.reviewInvalidatedAfterLatest;
      if (
        postDiffAssessment.approved
        && capturedHead !== null
        && capturedHead === approvedHead
        && postDiffDurable.headSha === capturedHead
        && latestReviewMatches
        && laneStillSettled
      ) {
        shippedDiff = typeof diffResultPayload.diff === 'string' ? diffResultPayload.diff : '';
        diffTruncated = diffResultPayload.truncated === true;
        diffHeadSha = capturedHead;
        diffBase = diffResultPayload.diffBase?.mergeBase
          ?? diffResultPayload.diffBase?.comparisonRef
          ?? null;
        if (mergePreview.wouldMerge === false) {
          pipelineOutcome = 'merge-preview-blocked';
          pipelineFailureReason = `merge preview blocked: ${mergePreview.blockers.join(', ') || 'unknown blocker'}`;
        } else {
          pipelineOutcome = 'review-approved';
        }
        break;
      }
    }

    if (convergenceAction === 'request-refix' && currentAttempt && currentAttempt.refix === null) {
      if (reviewAttempts.length >= MAX_GOVERNED_REVIEW_ATTEMPTS) {
        pipelineOutcome = 'review-bound-exhausted';
        pipelineFailureReason = `review rejected the governed output ${reviewAttempts.length} times`;
        break;
      }
      const assessment = durableReview ?? {
        approved: false,
        diffBudgetWaived: false,
        highConfidence: false,
        approvalId: null,
        reason: 'The review was rejected.',
      };
      const refix = runEndToEndCommand(input.o8CliPath, [
        'packet', 'rerun', '--packet', input.packetId,
        '--feedback', refixFeedback(currentAttempt, assessment),
      ], { cwd: input.repoRoot, timeoutMs: 10 * 60_000 });
      currentAttempt.refix = refix.receipt;
      if (refix.receipt.status !== 0) {
        streamErrors.push({ message: 'packet refix command failed', willRetry: false });
        pipelineOutcome = 'control-error';
        pipelineFailureReason = 'rejected review could not enter the normal refix loop';
        break;
      }
      durableReview = null;
      lastPacketStatus = null;
      lastLaneStatus = null;
      continue;
    }

    if (convergenceAction === 'fail-terminal') {
      pipelineOutcome = 'failed';
      pipelineFailureReason = typeof packet.blockedReason === 'string'
        ? packet.blockedReason
        : `lane reached ${lastLaneStatus ?? lastPacketStatus ?? 'a terminal state'}`;
      break;
    }
    if (convergenceAction === 'fail-blocked') {
      pipelineOutcome = 'blocked';
      pipelineFailureReason = typeof packet.blockedReason === 'string'
        ? packet.blockedReason
        : `lane blocked in ${lastLaneStatus ?? lastPacketStatus ?? 'an unknown state'}`;
      break;
    }
  }

  if (
    !pipelineOutcome
    && input.missionId
    && input.packetId
    && input.dispatch.status === 0
  ) {
    pipelineOutcome = 'timeout';
    pipelineFailureReason = 'governed pipeline timed out before a durable approved review for the current HEAD';
    streamErrors.push({ message: pipelineFailureReason, willRetry: false });
  }

  let streamStatus: TurnStatus | null = governedPipelineTerminalStatus(pipelineOutcome);
  if (streamStatus === null && (input.create.signal || input.dispatch.signal)) {
    streamStatus = TurnStatus.Interrupted;
  }
  let classification = classifyArmStatus({ status: streamStatus, source: 'stream', errors: streamErrors });
  let durableReconciliation: DurableReconciliationReceipt | null = null;
  if (input.packetId) {
    const durable = readDurablePacketState({
      packetId: input.packetId,
      expectedBase: input.base,
      completionBoundary: 'governed-review',
    });
    const reconciledReview = await assessDurableReview({
      durable,
      packetId: input.packetId,
      repoRoot: input.repoRoot,
    });
    if (reconciledReview) durableReview = reconciledReview;
    const reconciled = reconcileArmWithDurableState({
      streamStatus,
      streamErrors,
      durable,
      governedReview: durableReview,
      preserveObservedFailure: true,
    });
    classification = {
      outcome: reconciled.outcome,
      terminalStatus: reconciled.terminalStatus,
      classificationReason: reconciled.classificationReason,
      resultSource: reconciled.resultSource,
      errors: reconciled.errors,
    };
    durableReconciliation = reconciled.durableReconciliation;
    laneId = durable.laneId ?? laneId;
    sessionKey = durable.sessionKey ?? sessionKey;
    branch = durable.branch ?? branch;
    worktree = durable.worktreePath ?? worktree;
    if (
      durableReview?.approved === true
      && durable.view === 'full'
      && reconciled.durableReconciliation.durableStatus === TurnStatus.Completed
    ) {
      shippedDiff = durable.recoveredDiff;
      diffHeadSha = durable.headSha;
      diffBase = durable.diffBase;
      diffTruncated = false;
    }
  }

  const commandsPassed = input.create.status === 0
    && Boolean(input.missionId)
    && Boolean(input.packetId)
    && input.dispatch.status === 0
    && readCommandsPassed
    && finalStatusCommand?.status === 0
    && reviewAttempts.every((attempt) => attempt.refix === null || attempt.refix.status === 0)
    && (mergePreviewCommand === null || mergePreviewCommand.status === 0)
    && (packetDiffCommand === null || packetDiffCommand.status === 0);

  return {
    classification,
    shippedDiff,
    waitCommands,
    statusPolls: waitCommands.length,
    finalStatusCommand,
    finalStatus,
    cost,
    laneId,
    sessionKey,
    branch,
    worktree,
    durableReview,
    pipelineOutcome,
    pipelineFailureReason,
    packetDiffCommand,
    mergePreviewCommand,
    mergePreview,
    diffHeadSha,
    diffBase,
    diffTruncated,
    durableReconciliation,
    reviewAttempts,
    commandsPassed,
  };
}
