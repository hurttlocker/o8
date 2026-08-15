import type {
  ApprovalConflictReport,
  ApprovalGateResult,
  ApprovalRisk,
  MergeStrategy,
} from '@/lib/approvals/types';
import { resolveAttributedCommitMessage } from '@/lib/lane/commit-attribution';
import { checkExpectedHeadSha, formatHeadShaMismatchNote } from '@/lib/lane/head-sha-lock';
import { supersedeDurableApprovedReviews } from '@/lib/lane/durable-review-approval';
import { checkReviewedHeadIntegrity, formatReviewedHeadMismatchNote } from '@/lib/lane/review-head-integrity';
import { dogfoodPrOnlyActive, DOGFOOD_PR_ONLY_NOTE } from '@/lib/lane/dogfood-guard';
import {
  appendEvent,
  countLaneEventsByVerbSinceLastLaunch,
  getLane,
  setLaneStatus,
  updateLane,
} from '@/lib/lane/registry';
import { runLaneRebaseVerify } from '@/lib/lane/rebase-verify';
import type { Lane, LaneCommand, LaneCommandResult, LaneEventActor } from '@/lib/lane/types';
import {
  commitSpokenReviewSnapshotWithDriftRecovery,
  rejectInvalidSpokenReviewExecution,
  rejectSpokenReviewGovernanceDrift,
  rejectSpokenReviewSnapshotDrift,
  resolveSpokenReviewSnapshotSha,
  spokenReviewResolutionTransition,
  SpokenReviewSnapshotChangedError,
  validateSpokenReviewEvidenceBundle,
} from '@/lib/lane/spoken-review-snapshot';
import { emitProductEvent } from '@/lib/analytics/server';
import { getWorktreeManager } from '@/lib/worktree/launch';
import {
  WorktreeFetchUnreachableError,
  WorktreeRebaseConflictError,
  type WorktreeRebaseStrategy,
} from '@/lib/worktree/manager';
import {
  amendViaO8Suffix,
  commitDirtyWorktree,
  createDetachedIntegrationWorktree,
  currentBranch,
  deleteRefBestEffort,
  exactPushLeaseForCandidate,
  fetchWorkerHeadIntoMainRepo,
  git,
  gitErrorMessage,
  isAncestor,
  mergeRefForLane,
  pushExactBase, pushWorkerBranchBestEffort,
  pushWorkerBranchLeaseBestEffort,
  readHeadSha,
  refExists,
  refPointsTo,
  refreshOriginBaseBestEffort,
  worktreeExistsOnDisk,
} from '@/lib/lane/worktree-merge-git';
import { withRepoActionLock } from '@/lib/lane/repo-action-lock';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';

const BASE_ADVANCED_RETRY_LIMIT = 3;

type MergeCommand = Extract<LaneCommand, { verb: 'merge' }>;

type CreateLaneActionApproval = (
  lane: Lane,
  actor: LaneEventActor,
  input: {
    verb: 'merge' | 'create_pr';
    commitMessage?: string;
    expectedHeadSha?: string;
    reviewSummary?: string;
    title: string;
    description: string;
    summary: string;
    risk: ApprovalRisk;
    policyRuleId: string;
    metadata?: Record<string, string>;
    note: string;
    gateResult?: ApprovalGateResult;
    conflictReport?: ApprovalConflictReport;
    strategy?: MergeStrategy;
  },
) => Promise<LaneCommandResult>;

export interface WorktreeSideMergeInput {
  lane: Lane;
  command: MergeCommand;
  actor: LaneEventActor;
  gateResult: ApprovalGateResult;
  createLaneActionApproval: CreateLaneActionApproval;
}

async function enqueueDecompositions(repoPath: string, runtime: Lane['runtime']): Promise<string> {
  try {
    const { enqueueDecompositionsAfterMerge } = await import('@/lib/dispatch/decomposition-pipeline');
    const decomposition = await enqueueDecompositionsAfterMerge({ repoPath, runtime });
    if (decomposition.enqueued === 0) {
      return '';
    }
    const names = decomposition.candidates
      .map((candidate) => candidate.relativePath)
      .join(', ');
    return ` Enqueued ${decomposition.enqueued} decomposition dispatch${decomposition.enqueued === 1 ? '' : 'es'} for over-ceiling file${decomposition.enqueued === 1 ? '' : 's'}: ${names}.`;
  } catch (error) {
    console.warn(
      `[lane-merge] Decomposition scan failed for ${repoPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return '';
  }
}

function classifyFastForwardFailure(message: string): 'dirty-working-tree' | 'non-fast-forward' | 'invalid-ref' | 'merge-failed' {
  const lower = message.toLowerCase();
  if (lower.includes('would be overwritten') || lower.includes('local changes')) return 'dirty-working-tree';
  if (lower.includes('not possible to fast-forward') || lower.includes('not something we can merge')) return 'non-fast-forward';
  if (lower.includes('not a valid object name') || lower.includes('unknown revision') || lower.includes('invalid')) return 'invalid-ref';
  return 'merge-failed';
}

async function createRebaseConflictApproval(
  input: WorktreeSideMergeInput,
  error: WorktreeRebaseConflictError,
  recoveryWorktreePath = error.worktreePath,
): Promise<LaneCommandResult> {
  const { lane, command, actor, gateResult, createLaneActionApproval } = input;
  const files = error.conflictFiles;
  const conflictList = files.length > 0
    ? `\n\nConflicting files:\n${files.map((file) => `- ${file}`).join('\n')}`
    : '';
  const recoveryInstruction = recoveryWorktreePath === error.worktreePath ? `Resolve the rebase in ${recoveryWorktreePath}, or choose a conflict strategy and retry.`
    : `The isolated integration checkout was discarded. Reproduce the rebase from the packet worktree at ${recoveryWorktreePath}, or choose a conflict strategy and retry.`;
  return createLaneActionApproval(lane, actor, {
    verb: 'merge',
    commitMessage: command.commitMessage,
    expectedHeadSha: command.expectedHeadSha,
    reviewSummary: command.reviewSummary,
    title: `Rebase conflict: ${lane.label}`,
    description: `Worktree-side rebase failed before main was touched: ${error.message}${conflictList}\n\n${recoveryInstruction} o8 will not fall back to merging this packet into the operator checkout.`,
    summary: `Rebase conflict on ${lane.branch} -> ${lane.baseBranch}. ${files.length} file${files.length === 1 ? '' : 's'} conflicting.`,
    risk: 'high',
    policyRuleId: 'rebase_conflict_escalation',
    metadata: {
      ConflictFiles: files.join(', ') || 'unknown',
      FailureCategory: 'rebase-conflict',
    },
    note: `Rebase conflict escalated to operator. ${files.length} conflicting file${files.length === 1 ? '' : 's'}.`,
    gateResult: { passed: gateResult.passed, violations: gateResult.violations, diffBase: gateResult.diffBase },
    conflictReport: {
      files,
      mergeError: error.message,
    },
  });
}

async function createFastForwardFailureApproval(
  input: WorktreeSideMergeInput,
  error: unknown,
): Promise<LaneCommandResult> {
  const { lane, command, actor, gateResult, createLaneActionApproval } = input;
  const message = gitErrorMessage(error);
  const failureCategory = classifyFastForwardFailure(message);
  const title = failureCategory === 'dirty-working-tree'
    ? `Fast-forward blocked: ${lane.label} (main has uncommitted changes)`
    : failureCategory === 'non-fast-forward'
      ? `Fast-forward blocked: ${lane.label} (base moved)`
      : failureCategory === 'invalid-ref'
        ? `Fast-forward blocked: ${lane.label} (invalid integration ref)`
        : `Fast-forward failed: ${lane.label}`;
  const summary = failureCategory === 'dirty-working-tree'
    ? `Cannot fast-forward ${lane.baseBranch}: operator working-tree changes would be overwritten.`
    : failureCategory === 'non-fast-forward'
      ? `Cannot fast-forward ${lane.baseBranch}: the rebased packet head is no longer ahead of the current base.`
      : `Fast-forward of ${lane.branch} -> ${lane.baseBranch} failed: ${message}`;

  return createLaneActionApproval(lane, actor, {
    verb: 'merge',
    commitMessage: command.commitMessage,
    expectedHeadSha: command.expectedHeadSha,
    reviewSummary: command.reviewSummary,
    title,
    description: `The packet rebased cleanly in its worktree, but the final fast-forward in ${lane.repoPath} failed: ${message}\n\no8 did not stash, checkout, or run a fallback merge in the operator checkout.`,
    summary,
    risk: 'high',
    policyRuleId: 'fast_forward_failure_escalation',
    metadata: {
      ConflictFiles: 'n/a',
      FailureCategory: failureCategory,
    },
    note: `Fast-forward escalated to operator (${failureCategory}): ${message}`,
    gateResult: { passed: gateResult.passed, violations: gateResult.violations, diffBase: gateResult.diffBase },
    conflictReport: {
      files: [],
      mergeError: message,
    },
  });
}

function createFetchUnreachableResult(
  input: WorktreeSideMergeInput,
  error: WorktreeFetchUnreachableError,
): LaneCommandResult {
  const { lane, command } = input;
  setLaneStatus(command.laneId, 'reviewing', 'system', 'fetch_unreachable');
  return {
    ok: false,
    laneId: command.laneId,
    note: `Cannot refresh ${lane.baseBranch} before rebase: ${error.message}`,
  };
}

/**
 * Maximum bytes of tsc output we stuff into event payloads / blockedReason.
 * The head of the diagnostic is what the orchestrator needs to reason about;
 * the full output is still recoverable from the lane_events row.
 */
const TYPECHECK_FEEDBACK_MAX_BYTES = 4 * 1024;

function truncateForBlocker(output: string): string {
  if (output.length <= TYPECHECK_FEEDBACK_MAX_BYTES) return output;
  return `${output.slice(0, TYPECHECK_FEEDBACK_MAX_BYTES)}\n\n[truncated — full output in lane_events]`;
}

function formatTypecheckFeedback(lane: Lane, output: string): string {
  return [
    `Post-rebase typecheck failed after rebasing ${lane.branch} onto ${lane.baseBranch}.`,
    'Fix the type errors below, then commit so the operator can re-attempt the merge.',
    '',
    truncateForBlocker(output),
  ].join('\n');
}

/**
 * Read the packet's spent auto-rerun budget from control-plane state.
 * Returns null when the packet can't be found (caller falls back to the
 * per-lane event count, which is the legacy behavior).
 */
async function readPacketTypecheckRetries(
  packetId: string | null | undefined,
): Promise<number | null> {
  if (!packetId) return null;
  try {
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = readOrchestratorControlPlaneState().packets.find((p) => p.id === packetId);
    return packet ? (packet.typecheckAutoRetries ?? 0) : null;
  } catch {
    return null;
  }
}

async function handlePostRebaseVerifyFailure(
  input: WorktreeSideMergeInput,
  failure: { kind: 'typecheck' | 'tests'; output: string },
): Promise<LaneCommandResult> {
  const { lane, command, actor } = input;
  const truncatedOutput = truncateForBlocker(failure.output);
  // The retry budget lives ON the packet, not the lane: layer-1 auto-rerun
  // archives this lane and dispatches a brand-new one, so a per-lane count is
  // always 0 again on the retry's own merge attempt — which silently defeated
  // the "1 extra worker turn" cost ceiling and let a persistently type-broken
  // packet loop full workers. Per-lane count remains the fallback for lanes
  // whose packet isn't in control-plane state.
  const priorAutoRetries = (await readPacketTypecheckRetries(lane.packetId))
    ?? countLaneEventsByVerbSinceLastLaunch(command.laneId, 'typecheck_auto_retry');

  // ── Layer 2: escalate to orchestrator ──
  // Reached when layer 1 already fired during this lane lifecycle (or when we
  // have no packetId to redispatch against).
  if (priorAutoRetries >= 1 || !lane.packetId) {
    const escalationReason = priorAutoRetries >= 1 ? 'retry_exhausted' : 'no_packet';
    const blockedReason = !lane.packetId
      ? `${failure.kind === 'tests' ? 'Tests' : 'Typecheck'} failed after rebase onto ${lane.baseBranch}. No packetId on lane, cannot auto-rerun. Orchestrator decision needed (steer / redispatch / abandon).\n\n${truncatedOutput}`
      : `${failure.kind === 'tests' ? 'Tests' : 'Typecheck'} failed after 1 auto-retry. Orchestrator decision needed (steer / redispatch / abandon).\n\n${truncatedOutput}`;
    appendEvent(command.laneId, 'typecheck_escalation', 'system', {
      reason: escalationReason,
      priorAutoRetries,
      branch: lane.branch,
      baseBranch: lane.baseBranch,
      packetId: lane.packetId,
      output: truncatedOutput,
    });
    // The eventLabel is what the inbox / o8_status surfaces as the lane
    // headline; keep it short and structured so the orchestrator can scan.
    setLaneStatus(
      command.laneId,
      'awaiting_orchestrator',
      'system',
      `typecheck_escalated:${escalationReason}`,
    );
    return {
      ok: false,
      laneId: command.laneId,
      note: blockedReason,
    };
  }

  // ── Layer 1: auto-rerun (capped at 1) ──
  // Record the attempt BEFORE dispatching so a crash mid-rerun still counts —
  // we'd rather escalate on the next attempt than loop forever.
  appendEvent(command.laneId, 'typecheck_auto_retry', 'system', {
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    packetId: lane.packetId,
    output: truncatedOutput,
  });
  setLaneStatus(command.laneId, 'reviewing', actor, 'typecheck_auto_retry');

  await supersedeDurableApprovedReviews(lane.packetId, 'Superseded by typecheck auto-rerun.');

  // Persist the spent retry on the packet BEFORE dispatching — crash-safe in
  // the same spirit as the event append above: better to escalate next time
  // than to loop.
  try {
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    await withLockedState((current) => {
      const packet = current.packets.find((p) => p.id === lane.packetId);
      if (packet) packet.typecheckAutoRetries = (packet.typecheckAutoRetries ?? 0) + 1;
    });
  } catch (error) {
    console.warn(
      `[lane-merge] Could not persist typecheck retry budget for packet ${lane.packetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Fire-and-forget the redispatch. The operator's merge call returns
  // immediately; the new lane spins up async. If the call fails outright
  // we promote to awaiting_orchestrator so nothing silently stalls.
  const feedback = formatTypecheckFeedback(lane, failure.output);
  void (async () => {
    try {
      // Guard the reset_packet race (#1257): the operator may have held this
      // packet during the async gap before this rerun launches. A held packet
      // must never auto-dispatch — re-read the authoritative state and bail
      // rather than spawn a fresh session that makes reset_packet "not stick".
      const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
      const currentPacket = readOrchestratorControlPlaneState().packets.find((p) => p.id === lane.packetId);
      if (!currentPacket || currentPacket.queueState === 'held') {
        console.log(
          `[lane-merge] Skipping auto-rerun for packet ${lane.packetId} — ${currentPacket ? 'packet is held (reset_packet)' : 'packet no longer exists'} (#1257).`,
        );
        return;
      }
      const { rerunWithFeedback } = await import('@/lib/orchestrator/operator-mission-service');
      await rerunWithFeedback({ packetId: lane.packetId!, feedback });
      console.log(
        `[lane-merge] Auto-rerun dispatched for packet ${lane.packetId} after typecheck failure on lane ${command.laneId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[lane-merge] Auto-rerun failed for packet ${lane.packetId} on lane ${command.laneId}: ${message}`,
      );
      // Escalate so the operator/orchestrator sees the stall instead of a silent miss.
      appendEvent(command.laneId, 'typecheck_escalation', 'system', {
        reason: 'rerun_dispatch_failed',
        priorAutoRetries: priorAutoRetries + 1,
        branch: lane.branch,
        baseBranch: lane.baseBranch,
        packetId: lane.packetId,
        output: truncatedOutput,
        dispatchError: message,
      });
      setLaneStatus(command.laneId, 'awaiting_orchestrator', 'system', 'typecheck_rerun_failed');
    }
  })();

  return {
    ok: false,
    laneId: command.laneId,
    note: `Typecheck failed after rebase onto ${lane.baseBranch}. Auto-rerun dispatched with the tsc output as feedback; the packet will retry in a fresh worktree.\n\n${truncatedOutput}`,
  };
}

async function fetchOriginBaseForBaseDriftRetry(
  cwd: string,
  baseBranch: string,
  actualBranch: string,
): Promise<void> {
  try {
    await git(cwd, ['fetch', 'origin', baseBranch, '--quiet'], { timeout: 60_000 });
  } catch (error) {
    const fetchErrorMessage = gitErrorMessage(error);
    throw new WorktreeFetchUnreachableError({
      baseBranch,
      worktreePath: cwd,
      branch: actualBranch,
      localRefAgeMs: Number.POSITIVE_INFINITY,
      fetchErrorMessage,
      message: `fetch origin ${baseBranch} failed while retrying base-moved merge in ${cwd}: ${fetchErrorMessage}`,
    });
  }
}

async function retryBaseAdvancedAfterRebase(
  input: WorktreeSideMergeInput,
  opts: {
    mgr: ReturnType<typeof getWorktreeManager>;
    worktreePath: string;
    actualBranch: string;
    rebaseStrategy?: WorktreeRebaseStrategy;
    integrationRef: string;
    originBaseRef: string;
  },
): Promise<LaneCommandResult | null> {
  const { lane, command } = input;
  let lastOriginBaseRef = opts.originBaseRef;

  for (let attempt = 1; attempt <= BASE_ADVANCED_RETRY_LIMIT; attempt += 1) {
    const attemptLabel = `${attempt}/${BASE_ADVANCED_RETRY_LIMIT}`;
    console.warn(`[lane-merge] ${lastOriginBaseRef} advanced after rebase for ${opts.actualBranch}; auto-rebasing retry ${attemptLabel}.`);

    try {
      await fetchOriginBaseForBaseDriftRetry(lane.repoPath, lane.baseBranch, opts.actualBranch);
      await fetchOriginBaseForBaseDriftRetry(opts.worktreePath, lane.baseBranch, opts.actualBranch);
      await opts.mgr.rebaseOntoMain(opts.worktreePath, { baseBranch: lane.baseBranch, branchName: opts.actualBranch, strategy: opts.rebaseStrategy });
      console.log(`[lane-merge] Rebased ${opts.actualBranch} onto latest ${lane.baseBranch} after base-moved retry ${attemptLabel}`);
    } catch (error) {
      if (error instanceof WorktreeRebaseConflictError) {
        if (error.conflictFiles.length === 0) {
          // The rebase failed for a NON-conflict reason (timeout, strategy
          // arg, corrupt rebase state) and was already aborted clean — there
          // is nothing to "resolve". Routing it to a conflict card sent the
          // operator hunting for conflicts that don't exist.
          return createFastForwardFailureApproval(input, error);
        }
        return createRebaseConflictApproval(input, error, lane.worktreePath ?? error.worktreePath);
      }
      if (error instanceof WorktreeFetchUnreachableError) {
        return createFetchUnreachableResult(input, error);
      }
      throw error;
    }

    const verify = await runLaneRebaseVerify({ cwd: opts.worktreePath, actualBranch: opts.actualBranch, logPrefix: 'lane-merge' });
    if (!verify.ok) {
      return handlePostRebaseVerifyFailure(input, verify);
    }

    const { stdout: rebasedShaOutput } = await git(opts.worktreePath, ['rev-parse', 'HEAD']);
    await fetchWorkerHeadIntoMainRepo(
      lane.repoPath,
      opts.worktreePath,
      rebasedShaOutput.trim(),
      opts.integrationRef,
    );
    try {
      await fetchOriginBaseForBaseDriftRetry(lane.repoPath, lane.baseBranch, opts.actualBranch);
    } catch (error) {
      if (error instanceof WorktreeFetchUnreachableError) {
        return createFetchUnreachableResult(input, error);
      }
      throw error;
    }

    const originBaseRef = await refExists(lane.repoPath, opts.originBaseRef)
      ? opts.originBaseRef
      : null;
    if (!originBaseRef || await isAncestor(lane.repoPath, originBaseRef, opts.integrationRef)) {
      console.log(`[lane-merge] ${opts.actualBranch} includes ${originBaseRef ?? lane.baseBranch} after base-moved retry ${attemptLabel}`);
      return null;
    }
    lastOriginBaseRef = originBaseRef;
  }

  setLaneStatus(command.laneId, 'reviewing', 'system', 'base_advanced_after_rebase');
  return createFastForwardFailureApproval(
    input,
    new Error(`not possible to fast-forward: ${lastOriginBaseRef} advanced after ${BASE_ADVANCED_RETRY_LIMIT} auto-rebase attempts for ${opts.actualBranch}.`),
  );
}

export async function performWorktreeSideMerge(input: WorktreeSideMergeInput): Promise<LaneCommandResult> {
  const canonicalRepoPath = canonicalRepoRoot(input.command.canonicalRepoPath ?? input.lane.repoPath);
  const canonicalInput = canonicalRepoPath === input.lane.repoPath ? input : { ...input, lane: { ...input.lane, repoPath: canonicalRepoPath } };
  return withRepoActionLock(canonicalRepoPath, () => performWorktreeSideMergeInner(canonicalInput));
}

async function performWorktreeSideMergeInner(input: WorktreeSideMergeInput): Promise<LaneCommandResult> {
  const { lane, command, actor } = input;
  // #1173 — PR-only wall: refuse merge while the autonomous dogfood loop is driving.
  if (dogfoodPrOnlyActive()) return { ok: false, laneId: command.laneId, note: DOGFOOD_PR_ONLY_NOTE };
  const worktreePath = lane.worktreePath;
  if (!worktreePath) {
    return { ok: false, laneId: command.laneId, note: 'No worktree to merge. Lane is on the main working tree.' };
  }
  const spokenEvidence = validateSpokenReviewEvidenceBundle(command);
  let cleanupIntegrationWorktree: (() => Promise<void>) | undefined;
  try {
    if (!(await worktreeExistsOnDisk(worktreePath))) {
      setLaneStatus(command.laneId, 'reviewing', 'system', 'worktree_not_found');
      return { ok: false, laneId: command.laneId, note: `Worktree not found on disk: ${worktreePath}` };
    }

    const executionDrift = rejectInvalidSpokenReviewExecution({
      ...command,
      lane,
      actor,
      verb: 'merge',
    });
    if (executionDrift) return executionDrift;

    const governanceDrift = await rejectSpokenReviewGovernanceDrift({
      lane,
      actor,
      approvalId: command.spokenReviewApprovalId,
      expectedFingerprint: command.expectedGovernanceFingerprint,
      resolutionTransition: spokenReviewResolutionTransition(command),
      action: 'merging',
    });
    if (governanceDrift) return governanceDrift;

    const spokenDrift = await rejectSpokenReviewSnapshotDrift({
      lane, actor, expectedFingerprint: command.expectedDiffFingerprint, action: 'merging',
    });
    if (spokenDrift) return spokenDrift;

    setLaneStatus(command.laneId, 'merging', actor, 'merging');

    const mgr = getWorktreeManager(lane.repoPath);
    // Resolve the manager's worktree id from metadata; the path's last segment
    // is only a fallback (a divergent dir name makes cleanup silently no-op).
    const worktreeId = (await mgr.list()).find((w) => w.path === worktreePath)?.id
      ?? worktreePath.split('/').filter(Boolean).pop()!;

    const reviewedHead = await checkReviewedHeadIntegrity(lane, worktreePath);
    if (!reviewedHead.ok) {
      setLaneStatus(command.laneId, 'reviewing', 'system', 'review_invalidated');
      appendEvent(command.laneId, 'review_invalidated', actor, {
        reviewedHeadSha: reviewedHead.reviewedHeadSha,
        currentHeadSha: reviewedHead.currentHeadSha,
        branch: lane.branch,
        baseBranch: lane.baseBranch,
        packetId: lane.packetId,
      });
      return { ok: false, laneId: command.laneId, note: formatReviewedHeadMismatchNote(reviewedHead), reason: 'head_moved_since_review', reviewedHeadSha: reviewedHead.reviewedHeadSha, currentHeadSha: reviewedHead.currentHeadSha };
    }

    const headLock = await checkExpectedHeadSha(worktreePath, command.expectedHeadSha);
    if (!headLock.ok) {
      setLaneStatus(command.laneId, 'reviewing', 'system', 'head_sha_drift');
      appendEvent(command.laneId, 'merge_head_drift', actor, {
        expectedHeadSha: headLock.expectedHeadSha,
        currentHeadSha: headLock.currentHeadSha,
        branch: lane.branch,
        baseBranch: lane.baseBranch,
        packetId: lane.packetId,
      });
      return {
        ok: false,
        laneId: command.laneId,
        note: formatHeadShaMismatchNote(headLock),
        expectedHeadSha: headLock.expectedHeadSha,
        currentHeadSha: headLock.currentHeadSha,
      };
    }

    const actualBranch = await currentBranch(worktreePath);
    if (!actualBranch || actualBranch === 'HEAD') {
      return { ok: false, laneId: command.laneId, note: 'Cannot merge detached worktree HEAD.' };
    }
    console.log(`[lane-merge] Actual worktree branch: ${actualBranch} (lane.branch: ${lane.branch})`);

    if (command.strategy === 'manual') {
      setLaneStatus(command.laneId, 'awaiting_input', actor, 'manual_resolution');
      return {
        ok: false,
        laneId: command.laneId,
        note: `Lane parked for manual rebase resolution in ${worktreePath}. Resolve the rebase, then retry merge.`,
      };
    }

    let reviewedSnapshotSha: string;
    if (spokenEvidence.present && command.commitMessage) {
      const commit = await commitSpokenReviewSnapshotWithDriftRecovery({
        lane,
        actor,
        commitMessage: resolveAttributedCommitMessage(command.commitMessage),
        expectedFingerprint: command.expectedDiffFingerprint,
      });
      if (commit.result) return commit.result;
      if (commit.error) {
        // Surface snapshot failures at the commit boundary so the lane never
        // continues into rebase with an unpublished or ambiguous reviewed tree.
        console.warn(`[lane-merge] commitSpokenReviewSnapshot failed: ${commit.error instanceof Error ? commit.error.message : String(commit.error)}`);
        return {
          ok: false,
          laneId: command.laneId,
          note: commit.error instanceof Error ? commit.error.message : String(commit.error),
        };
      }
      reviewedSnapshotSha = commit.snapshotSha!;
    } else if (spokenEvidence.present) {
      try {
        reviewedSnapshotSha = await resolveSpokenReviewSnapshotSha({
          lane,
          expectedFingerprint: command.expectedDiffFingerprint,
        });
      } catch (error) {
        if (error instanceof SpokenReviewSnapshotChangedError) {
          return {
            ok: false,
            laneId: command.laneId,
            note: error.message,
            reason: 'diff_changed_since_spoken_review',
          };
        }
        throw error;
      }
    } else {
      if (command.commitMessage) {
        try {
          await commitDirtyWorktree(
            worktreePath,
            resolveAttributedCommitMessage(command.commitMessage),
          );
        } catch (error) {
          console.warn(`[lane-merge] commitDirtyWorktree non-fatal: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      reviewedSnapshotSha = await readHeadSha(worktreePath);
    }

    let mergeWorktreePath = worktreePath;
    if (spokenEvidence.present) {
      const integration = await createDetachedIntegrationWorktree({
        repoPath: lane.repoPath,
        sourceWorktreePath: worktreePath,
        sourceSha: reviewedSnapshotSha,
      });
      mergeWorktreePath = integration.path;
      cleanupIntegrationWorktree = integration.cleanup;
    }

    const rebaseStrategy: WorktreeRebaseStrategy | undefined = command.strategy === 'ours' || command.strategy === 'theirs'
      ? command.strategy
      : undefined;
    try {
      await mgr.rebaseOntoMain(mergeWorktreePath, {
        baseBranch: lane.baseBranch,
        branchName: actualBranch,
        strategy: rebaseStrategy,
      });
      console.log(`[lane-merge] Rebased ${actualBranch} onto latest ${lane.baseBranch} in worktree`);
    } catch (error) {
      if (error instanceof WorktreeRebaseConflictError) {
        if (error.conflictFiles.length === 0) {
          // The rebase failed for a NON-conflict reason (timeout, strategy
          // arg, corrupt rebase state) and was already aborted clean — there
          // is nothing to "resolve". Routing it to a conflict card sent the
          // operator hunting for conflicts that don't exist.
          return createFastForwardFailureApproval(input, error);
        }
        return createRebaseConflictApproval(input, error, worktreePath);
      }
      if (error instanceof WorktreeFetchUnreachableError) {
        return createFetchUnreachableResult(input, error);
      }
      throw error;
    }

    const verify = await runLaneRebaseVerify({
      cwd: mergeWorktreePath,
      actualBranch,
      logPrefix: 'lane-merge',
    });
    if (!verify.ok) {
      // #1108 — Layered escalation. Layer 1 fires an auto-rerun_with_feedback
      // (capped at 1 per lane lifecycle); layer 2 promotes to
      // awaiting_orchestrator so o8_status surfaces the blocker. Layers 3-5
      // (steer warm session / fresh redispatch / human approval) are owned
      // by the orchestrator and not handled in this file.
      return handlePostRebaseVerifyFailure(input, verify);
    }

    if (!reviewedHead.reviewedHeadSha) await amendViaO8Suffix(mergeWorktreePath, lane.label);
    const { stdout: rebasedShaOutput } = await git(mergeWorktreePath, ['rev-parse', 'HEAD']);
    const rebasedSha = rebasedShaOutput.trim();

    const publicationGovernanceDrift = await rejectSpokenReviewGovernanceDrift({
      lane,
      actor,
      approvalId: command.spokenReviewApprovalId,
      expectedFingerprint: command.expectedGovernanceFingerprint,
      resolutionTransition: spokenReviewResolutionTransition(command),
      action: 'merging',
    });
    if (publicationGovernanceDrift) return publicationGovernanceDrift;
    const integrationRef = mergeRefForLane(command.laneId);
    let mergeCandidateSha = rebasedSha;
    let expectedRemoteBaseSha: string | undefined;
    try {
      await fetchWorkerHeadIntoMainRepo(lane.repoPath, mergeWorktreePath, rebasedSha, integrationRef);
      await pushWorkerBranchBestEffort(worktreePath, actualBranch, rebasedSha);
      const originBaseRef = await refreshOriginBaseBestEffort(lane.repoPath, lane.baseBranch);
      if (originBaseRef && !(await isAncestor(lane.repoPath, originBaseRef, integrationRef))) {
        const retryResult = await retryBaseAdvancedAfterRebase(input, {
          mgr,
          worktreePath: mergeWorktreePath,
          actualBranch,
          rebaseStrategy,
          integrationRef,
          originBaseRef,
        });
        if (retryResult) return retryResult;
      }

      const mainCheckoutBranch = await currentBranch(lane.repoPath);
      if (mainCheckoutBranch !== lane.baseBranch) {
        setLaneStatus(command.laneId, 'reviewing', 'system', 'base_checkout_mismatch');
        return {
          ok: false,
          laneId: command.laneId,
          note: `Fast-forward requires ${lane.repoPath} to be on ${lane.baseBranch}; current branch is ${mainCheckoutBranch}.`,
        };
      }

      const integrationSha = (await git(lane.repoPath, ['rev-parse', integrationRef], { timeout: 5000 })).stdout.trim();
      mergeCandidateSha = integrationSha;
      if (integrationSha !== rebasedSha) {
        await pushWorkerBranchLeaseBestEffort(worktreePath, actualBranch, integrationSha, rebasedSha);
      }
      const pushLease = await exactPushLeaseForCandidate(lane.repoPath, originBaseRef, integrationRef);
      if (!pushLease.safe) return createFastForwardFailureApproval(input, new Error(`${originBaseRef} is no longer an ancestor of the exact reviewed candidate.`));
      expectedRemoteBaseSha = pushLease.expectedRemoteSha;

      const finalGovernanceDrift = await rejectSpokenReviewGovernanceDrift({
        lane,
        actor,
        approvalId: command.spokenReviewApprovalId,
        expectedFingerprint: command.expectedGovernanceFingerprint,
        resolutionTransition: spokenReviewResolutionTransition(command),
        action: 'merging',
      });
      if (finalGovernanceDrift) return finalGovernanceDrift;

      try {
        await git(lane.repoPath, ['merge', '--ff-only', integrationRef], { timeout: 60_000 });
      } catch (error) {
        return createFastForwardFailureApproval(input, error);
      }
    } finally {
      await deleteRefBestEffort(lane.repoPath, integrationRef);
    }

    const canonicalAncestryVerified = await isAncestor(lane.repoPath, mergeCandidateSha, lane.baseBranch);
    if (!(await refPointsTo(lane.repoPath, `refs/heads/${lane.baseBranch}`, mergeCandidateSha)) || !canonicalAncestryVerified) {
      const failure = await createFastForwardFailureApproval(
        input,
        new Error(`canonical merge ancestry postcondition failed: ${mergeCandidateSha} is not an ancestor of ${lane.baseBranch} in ${lane.repoPath}`),
      );
      setLaneStatus(command.laneId, 'awaiting_orchestrator', 'system', 'canonical_merge_ancestry_failed');
      return { ...failure, reason: 'canonical_merge_ancestry_failed' };
    }
    const mergeSha = mergeCandidateSha;
    appendEvent(command.laneId, 'merge', actor, { laneHeadSha: mergeSha, baseBranch: lane.baseBranch });
    let pushedToOrigin = false, pushError: string | undefined;
    try {
      await pushExactBase(lane.repoPath, lane.baseBranch, mergeSha, expectedRemoteBaseSha);
      pushedToOrigin = true;
      console.log(`[lane-merge] Pushed ${lane.baseBranch} to origin after fast-forwarding ${actualBranch}`);
    } catch (error) {
      pushError = gitErrorMessage(error);
      console.warn(`[lane-merge] Push to origin failed for ${lane.baseBranch} after fast-forwarding ${actualBranch}: ${pushError}`);
    }
    await mgr.cleanup(worktreeId, { force: true, deleteBranch: true, mergedEquivalentHeadSha: spokenEvidence.present ? reviewedSnapshotSha : undefined, workspaceRetirementAction: 'merge' });
    void mgr.prune().catch(() => {});
    updateLane(command.laneId, {
      worktreePath: null,
      // Durable terminal outcome — post-merge cleanup archives this lane
      // soon after, and the rail's Recent group renders this chip so merged
      // agents never evaporate from the clean view (Q ruling 2026-07-18).
      outcome: 'merged',
      outcomeNote: `Merged ${lane.branch} into ${lane.baseBranch}${pushedToOrigin ? ' and pushed to origin' : ''}.`,
    }, 'system');
    setLaneStatus(command.laneId, 'completed', actor, pushedToOrigin ? 'merged_pushed' : 'merged');

    // Coarse product signal: the governance loop closed. Fire-and-forget.
    void emitProductEvent('merge.approved', { runtime: lane.runtime, pushed: pushedToOrigin });

    const decompositionNote = await enqueueDecompositions(lane.repoPath, lane.runtime);
    const updated = getLane(command.laneId);
    const mergeNote = pushedToOrigin
      ? `Rebased ${lane.branch} onto ${lane.baseBranch}, fast-forwarded ${lane.baseBranch}, and pushed to origin.${decompositionNote}`
      : `Rebased ${lane.branch} onto ${lane.baseBranch} and fast-forwarded ${lane.baseBranch} LOCALLY - push to origin failed: ${pushError ?? 'unknown error'}. Run \`git push origin ${lane.baseBranch}\` to ship the commit.${decompositionNote}`;
    return {
      ok: true,
      laneId: command.laneId,
      note: mergeNote,
      lane: updated ?? undefined,
      mergeSha,
      pushedToOrigin,
      pushError,
    };
  } catch (error) {
    setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_error');
    return { ok: false, laneId: command.laneId, note: gitErrorMessage(error) };
  } finally {
    await cleanupIntegrationWorktree?.();
  }
}
