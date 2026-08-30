import type {
  ApprovalConflictReport,
  ApprovalGateResult,
  ApprovalRisk,
  MergeStrategy,
} from '@/lib/approvals/types';
import { resolveAttributedCommitMessage } from '@/lib/lane/commit-attribution';
import { checkExpectedHeadSha, formatHeadShaMismatchNote } from '@/lib/lane/head-sha-lock';
import { checkReviewedHeadIntegrity, formatReviewedHeadMismatchNote } from '@/lib/lane/review-head-integrity';
import { dogfoodPrOnlyActive, DOGFOOD_PR_ONLY_NOTE } from '@/lib/lane/dogfood-guard';
import {
  appendEvent,
  getLane,
  setLaneStatus,
} from '@/lib/lane/registry';
import { runLaneRebaseVerify } from '@/lib/lane/rebase-verify';
import { buildCheckList } from '@/lib/lane/preview-merge';
import type { Lane, LaneCommand, LaneCommandResult, LaneEventActor } from '@/lib/lane/types';
import { handlePostRebaseVerifyFailure } from '@/lib/lane/worktree-side-merge-verify';
import { settleSuccessfulMergeWorktreeCleanup } from '@/lib/lane/successful-merge-worktree-cleanup';
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
import {
  resolveMergeBranchForLane,
  type MergeBranchResolver,
} from '@/lib/lane/worktree-merge-branch';
import { withRepoActionRecovery } from '@/lib/lane/repo-action-lock';
import { settleReturnedMergeState } from '@/lib/lane/merge-state-settlement';
import { enqueueMergeDecompositions } from '@/lib/lane/merge-decomposition';
import { fastForwardBaseBranch } from '@/lib/lane/operator-checkout-merge';
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
  repoActionLeaseMaxWaitMs?: number;
  branchResolver?: MergeBranchResolver;
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
    ? `Fast-forward blocked: ${lane.label} (${lane.baseBranch} has uncommitted changes)`
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
    reason: 'fetch_unreachable',
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

    const verify = await runLaneRebaseVerify({
      cwd: opts.worktreePath,
      baseRef: lane.baseBranch,
      actualBranch: opts.actualBranch,
      logPrefix: 'lane-merge',
    });
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
  const result = await withRepoActionRecovery(
    canonicalRepoPath,
    {
      laneId: input.command.laneId,
      packetId: input.lane.packetId,
      maxWaitMs: input.repoActionLeaseMaxWaitMs,
    },
    () => performWorktreeSideMergeInner(canonicalInput),
  );
  return settleReturnedMergeState(input.command.laneId, result, input.actor);
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

    const branch = await resolveMergeBranchForLane({
      lane,
      worktreePath,
      branchResolver: input.branchResolver,
    });
    if (!branch.ok) return branch.result;
    const actualBranch = branch.actualBranch;
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
      baseRef: lane.baseBranch,
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
    const mergeChecks = buildCheckList(input.gateResult, verify.checks);

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
        await fastForwardBaseBranch({
          repoPath: lane.repoPath,
          baseBranch: lane.baseBranch,
          candidateRef: integrationRef,
          candidateSha: integrationSha,
        });
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
    const worktreeRemoved = await settleSuccessfulMergeWorktreeCleanup({
      manager: mgr,
      lane,
      worktreeId,
      pushedToOrigin,
      mergedEquivalentHeadSha: spokenEvidence.present ? reviewedSnapshotSha : undefined,
    });
    setLaneStatus(command.laneId, 'completed', actor, pushedToOrigin ? 'merged_pushed' : 'merged');

    // Coarse product signal: the governance loop closed. Fire-and-forget.
    void emitProductEvent('merge.approved', { runtime: lane.runtime, pushed: pushedToOrigin });

    const decompositionNote = await enqueueMergeDecompositions(lane.repoPath, lane.runtime);
    const updated = getLane(command.laneId);
    const cleanupNote = worktreeRemoved ? '' : ' Worktree cleanup is pending and remains addressable for retry.';
    const mergeNote = pushedToOrigin
      ? `Rebased ${lane.branch} onto ${lane.baseBranch}, fast-forwarded ${lane.baseBranch}, and pushed to origin.${cleanupNote}${decompositionNote}`
      : `Rebased ${lane.branch} onto ${lane.baseBranch} and fast-forwarded ${lane.baseBranch} LOCALLY - push to origin failed: ${pushError ?? 'unknown error'}. Run \`git push origin ${lane.baseBranch}\` to ship the commit.${cleanupNote}${decompositionNote}`;
    return {
      ok: true,
      laneId: command.laneId,
      note: mergeNote,
      lane: updated ?? undefined,
      mergeSha,
      pushedToOrigin,
      pushError,
      checks: mergeChecks,
      blockers: [],
    };
  } catch (error) {
    setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_error');
    return { ok: false, laneId: command.laneId, note: gitErrorMessage(error) };
  } finally {
    await cleanupIntegrationWorktree?.();
  }
}
