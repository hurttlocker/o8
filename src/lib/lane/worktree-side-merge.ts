import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

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
import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import { emitProductEvent } from '@/lib/analytics/server';
import { getWorktreeManager } from '@/lib/worktree/launch';
import {
  WorktreeFetchUnreachableError,
  WorktreeRebaseConflictError,
  type WorktreeRebaseStrategy,
} from '@/lib/worktree/manager';

const execFileAsync = promisify(execFile);
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

async function git(cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}) {
  return execFileAsync('git', args, {
    cwd,
    timeout: opts.timeout ?? 60_000,
    maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
  });
}

function gitErrorMessage(error: unknown): string {
  const err = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr.trim()
    : err.stderr instanceof Buffer ? err.stderr.toString('utf8').trim()
    : '';
  const stdout = typeof err.stdout === 'string' ? err.stdout.trim()
    : err.stdout instanceof Buffer ? err.stdout.toString('utf8').trim()
    : '';
  const message = typeof err.message === 'string' ? err.message.trim() : String(error);
  return stderr || stdout || message || 'Git command failed.';
}

async function worktreeExistsOnDisk(worktreePath: string): Promise<boolean> {
  try {
    const dirStat = await stat(worktreePath);
    if (!dirStat.isDirectory()) return false;
    const gitStat = await stat(`${worktreePath}/.git`);
    return gitStat.isFile() || gitStat.isDirectory();
  } catch {
    return false;
  }
}

async function commitDirtyWorktree(worktreePath: string, commitMessage: string): Promise<void> {
  await git(worktreePath, ['add', '-A']);
  const { stdout: porcelain } = await git(worktreePath, ['status', '--porcelain'], { timeout: 5000 });
  if (porcelain.trim()) {
    await git(worktreePath, ['commit', '-m', resolveAttributedCommitMessage(commitMessage)]);
  }
}

async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 });
  return stdout.trim();
}
async function amendViaO8Suffix(worktreePath: string, fallbackSubject?: string): Promise<void> {
  try {
    const { stdout: tipSubject } = await git(worktreePath, ['log', '-1', '--pretty=%s'], { timeout: 5000 });
    const subject = tipSubject.trim();
    if (subject && !subject.includes('[via-o8]')) {
      const nextSubject = subject === 'auto-commit: agent work before review' && fallbackSubject?.trim() ? fallbackSubject.trim() : subject;
      await git(worktreePath, ['commit', '--amend', '-m', `${nextSubject} [via-o8]`, '--allow-empty']);
    }
  } catch {
    // Best-effort tag for changelog rendering. Never block a valid merge.
  }
}

function mergeRefForLane(laneId: string): string {
  return `refs/o8/merge/${laneId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

async function deleteRefBestEffort(repoPath: string, ref: string): Promise<void> {
  try {
    await git(repoPath, ['update-ref', '-d', ref], { timeout: 5000 });
  } catch {
    // Temporary integration refs are best-effort cleanup only.
  }
}

async function pushWorkerBranchBestEffort(worktreePath: string, actualBranch: string): Promise<void> {
  try {
    await git(worktreePath, ['push', '-u', 'origin', actualBranch], { timeout: 60_000 });
    console.log(`[lane-merge] Pushed worker branch ${actualBranch} to origin before fast-forward.`);
  } catch (error) {
    console.warn(
      `[lane-merge] Worker branch push skipped for ${actualBranch}: ${gitErrorMessage(error)}`,
    );
  }
}

async function fetchWorkerHeadIntoMainRepo(
  repoPath: string,
  worktreePath: string,
  actualBranch: string,
  integrationRef: string,
): Promise<void> {
  await git(repoPath, ['fetch', worktreePath, `+${actualBranch}:${integrationRef}`], { timeout: 60_000 });
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', ref], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function refreshOriginBaseBestEffort(repoPath: string, baseBranch: string): Promise<string | null> {
  try {
    await git(repoPath, ['fetch', 'origin', baseBranch, '--quiet'], { timeout: 60_000 });
  } catch (error) {
    console.warn(`[lane-merge] Could not refresh origin/${baseBranch} before fast-forward: ${gitErrorMessage(error)}`);
  }

  const originRef = `origin/${baseBranch}`;
  return await refExists(repoPath, originRef) ? originRef : null;
}

async function syncWorktreeBaseForCleanup(
  repoPath: string,
  worktreePath: string,
  baseBranch: string,
): Promise<void> {
  try {
    await git(worktreePath, ['fetch', repoPath, `${baseBranch}:${baseBranch}`], { timeout: 30_000 });
  } catch (error) {
    console.warn(
      `[lane-merge] Could not sync ${baseBranch} back into worktree before cleanup: ${gitErrorMessage(error)}`,
    );
  }
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
): Promise<LaneCommandResult> {
  const { lane, command, actor, gateResult, createLaneActionApproval } = input;
  const files = error.conflictFiles;
  const conflictList = files.length > 0
    ? `\n\nConflicting files:\n${files.map((file) => `- ${file}`).join('\n')}`
    : '';
  return createLaneActionApproval(lane, actor, {
    verb: 'merge',
    commitMessage: command.commitMessage,
    expectedHeadSha: command.expectedHeadSha,
    reviewSummary: command.reviewSummary,
    title: `Rebase conflict: ${lane.label}`,
    description: `Worktree-side rebase failed before main was touched: ${error.message}${conflictList}\n\nResolve the rebase in ${error.worktreePath}, or choose a conflict strategy and retry. o8 will not fall back to merging this packet into the operator checkout.`,
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
        return createRebaseConflictApproval(input, error);
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

    await fetchWorkerHeadIntoMainRepo(lane.repoPath, opts.worktreePath, opts.actualBranch, opts.integrationRef);
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

/**
 * Per-repo merge serialization. The fast-forward + push section mutates the
 * SHARED operator checkout (`lane.repoPath`) — two concurrent merges in the
 * same repo race `git merge --ff-only` / `git push` / index locks against
 * each other. Different repos still merge in parallel. Single-process by
 * design: every merge flows through this module via dispatchLaneCommand.
 */
const repoMergeChains = new Map<string, Promise<unknown>>();

function withRepoMergeLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  return chainOnKey(repoMergeChains, repoPath, fn);
}

export async function performWorktreeSideMerge(input: WorktreeSideMergeInput): Promise<LaneCommandResult> {
  return withRepoMergeLock(input.lane.repoPath, () => performWorktreeSideMergeInner(input));
}

async function performWorktreeSideMergeInner(input: WorktreeSideMergeInput): Promise<LaneCommandResult> {
  const { lane, command, actor } = input;
  // #1173 — PR-only wall: refuse merge while the autonomous dogfood loop is driving.
  if (dogfoodPrOnlyActive()) return { ok: false, laneId: command.laneId, note: DOGFOOD_PR_ONLY_NOTE };
  const worktreePath = lane.worktreePath;
  if (!worktreePath) {
    return { ok: false, laneId: command.laneId, note: 'No worktree to merge. Lane is on the main working tree.' };
  }

  try {
    if (!(await worktreeExistsOnDisk(worktreePath))) {
      setLaneStatus(command.laneId, 'reviewing', 'system', 'worktree_not_found');
      return {
        ok: false,
        laneId: command.laneId,
        note: `Worktree not found on disk: ${worktreePath}`,
      };
    }

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

    if (command.commitMessage) {
      try {
        await commitDirtyWorktree(worktreePath, command.commitMessage);
      } catch (err) {
        // Preserve historical merge behavior: a clean tree or failed empty commit
        // attempt should not block the merge path. Log it — a genuinely failed
        // commit (lock contention, hooks, disk) otherwise resurfaces later as a
        // confusing "rebase conflict" with no cause attached.
        console.warn(`[lane-merge] commitDirtyWorktree non-fatal: ${err instanceof Error ? err.message : String(err)}`);
      }
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

    const rebaseStrategy: WorktreeRebaseStrategy | undefined = command.strategy === 'ours' || command.strategy === 'theirs'
      ? command.strategy
      : undefined;
    try {
      await mgr.rebaseOntoMain(worktreePath, {
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
        return createRebaseConflictApproval(input, error);
      }
      if (error instanceof WorktreeFetchUnreachableError) {
        return createFetchUnreachableResult(input, error);
      }
      throw error;
    }

    const verify = await runLaneRebaseVerify({
      cwd: worktreePath,
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

    if (!reviewedHead.reviewedHeadSha) await amendViaO8Suffix(worktreePath, lane.label);
    await pushWorkerBranchBestEffort(worktreePath, actualBranch);

    const integrationRef = mergeRefForLane(command.laneId);
    try {
      await fetchWorkerHeadIntoMainRepo(lane.repoPath, worktreePath, actualBranch, integrationRef);
      const originBaseRef = await refreshOriginBaseBestEffort(lane.repoPath, lane.baseBranch);
      if (originBaseRef && !(await isAncestor(lane.repoPath, originBaseRef, integrationRef))) {
        const retryResult = await retryBaseAdvancedAfterRebase(input, {
          mgr,
          worktreePath,
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

      try {
        await git(lane.repoPath, ['merge', '--ff-only', integrationRef], { timeout: 60_000 });
      } catch (error) {
        return createFastForwardFailureApproval(input, error);
      }
    } finally {
      await deleteRefBestEffort(lane.repoPath, integrationRef);
    }

    const { stdout: mergeShaStdout } = await git(lane.repoPath, ['rev-parse', 'HEAD'], { timeout: 5000 });
    const mergeSha = mergeShaStdout.trim();
    appendEvent(command.laneId, 'merge', actor, { laneHeadSha: mergeSha, baseBranch: lane.baseBranch });
    let pushedToOrigin = false, pushError: string | undefined;
    try {
      await git(lane.repoPath, ['push', 'origin', lane.baseBranch], { timeout: 60_000 });
      pushedToOrigin = true;
      console.log(`[lane-merge] Pushed ${lane.baseBranch} to origin after fast-forwarding ${actualBranch}`);
    } catch (error) {
      pushError = gitErrorMessage(error);
      console.warn(`[lane-merge] Push to origin failed for ${lane.baseBranch} after fast-forwarding ${actualBranch}: ${pushError}`);
    }

    await syncWorktreeBaseForCleanup(lane.repoPath, worktreePath, lane.baseBranch);
    await mgr.cleanup(worktreeId, { force: true, deleteBranch: true });
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
  }
}
