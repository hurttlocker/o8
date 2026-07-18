/**
 * Lane Command Bus
 *
 * Single entry point for all lane mutations. Human UI, Claude orchestrator,
 * and automations all call the same verbs.
 *
 * Verbs: open_lane, bind_worktree, launch_session, attach_session,
 *        send_turn, interrupt, request_review, complete, archive
 */

import type {
  LaneCommand,
  LaneCommandResult,
  LaneEventActor,
  Lane,
} from '@/lib/lane/types';
import type { ApprovalRisk } from '@/lib/approvals/types';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  createLane,
  getLane,
  getLaneEvents,
  updateLane,
  setLaneStatus,
  attachSession,
  archiveLane,
  appendEvent,
} from '@/lib/lane/registry';
import { parsePullRequestNumber } from '@/lib/lane/pr-number';
import { rebindLaneSessionIfChanged } from '@/lib/lane/session-rebind';
// A lane whose worker can never spawn (e.g. its worktree/cwd was cleaned up)
// otherwise loops launching→idle forever — the scheduler re-dispatches on every
// launch_error/launch_failed with no ceiling. Cap the attempts so it fails
// terminally and surfaces for operator attention instead of churning the DB.
const LAUNCH_ATTEMPT_CAP = 5;
import { getLanePolicy, isProtectedBranch } from '@/lib/lane/policy';
import { getSqlite } from '@/lib/db';
import { evaluatePolicy, buildPolicyContext } from '@/lib/approvals/policies';
import { createApproval, recordApprovalAudit } from '@/lib/approvals/store';
import { cleanupRemoteMergeWorktree, fetchWorkerBranch } from '@/lib/lane/remote-fetch';
import { FILE_SIZE_BLOCK_THRESHOLD_LINES } from '@/lib/orchestrator/dispatch';
import { hasDurableApprovedReview } from '@/lib/lane/durable-review-approval';
import { formatOversizedFiles, getOversizedChangedFilesForLane } from '@/lib/lane/file-size-policy';
import { runMergeGate, formatMergeGateViolations } from '@/lib/lane/merge-gate';
import { probeNoChangesProduced } from '@/lib/lane/no-changes-produced';
import { runLaneRebaseTypecheck } from '@/lib/lane/rebase-typecheck';
import { performWorktreeSideMerge } from '@/lib/lane/worktree-side-merge';
import { dogfoodPrOnlyActive, DOGFOOD_PR_ONLY_NOTE } from '@/lib/lane/dogfood-guard';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { emitProductEvent } from '@/lib/analytics/server';
import { buildConflictZonesFromDiffFiles, extractReviewFindings, extractReviewPatterns } from '@/lib/orchestrator/review-lessons';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { fetchWorkerRun } from '@/lib/worker/runs';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { parseGitDiff } from '@/lib/worktree/diff-parser';

type MergeCommand = Extract<LaneCommand, { verb: 'merge' }>;

// F38 (#1030): the merge handler previously trusted WorktreeManager's in-memory
// list. Dev-bridge restarts wiped that state mid-packet, leaving the lane row
// pointing at a worktree the manager no longer knew about — even though the
// directory and its .git were sitting right there on disk. Bail behavior:
// "Worktree not found on disk" was wrong because nothing actually checked disk.
//
// This helper restores disk truth: it accepts a path and confirms it's a real
// worktree by checking for the directory + an inner .git entry (file pointer
// for linked worktrees, dir for standalone repos). No in-memory state involved.
async function worktreeExistsOnDisk(worktreePath: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    const dirStat = await stat(worktreePath);
    if (!dirStat.isDirectory()) return false;
    const gitStat = await stat(`${worktreePath}/.git`);
    return gitStat.isFile() || gitStat.isDirectory();
  } catch {
    return false;
  }
}
async function getDiffForLane(lane: Pick<Lane, 'baseBranch' | 'worktreePath' | 'repoPath'>) {
  const cwd = lane.worktreePath || lane.repoPath;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const result = await execFileAsync('git', ['diff', `${lane.baseBranch}...HEAD`, '--no-color'], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    try {
      const fallback = await execFileAsync('git', ['diff', 'HEAD~1', '--no-color'], { cwd, maxBuffer: 10 * 1024 * 1024 });
      return fallback.stdout.trim();
    } catch {
      return '';
    }
  }
}

async function recordReviewLessonsForApproval(
  approvalId: string,
  lane: Lane,
  reviewSummary: string | undefined,
  files: ReturnType<typeof parseGitDiff>,
) {
  const summary = reviewSummary?.trim();
  if (!summary) {
    return;
  }

  const findings = extractReviewFindings(summary);
  const patterns = extractReviewPatterns(summary, findings);
  const conflictZones = buildConflictZonesFromDiffFiles(files);
  const approved = /\b(approve|approved|looks correct|ready to merge|ship it)\b/i.test(summary)
    ? true
    : /\b(request changes|reject|den(y|ied)|not ready|blocked)\b/i.test(summary)
      ? false
      : findings.length === 0;

  recordApprovalAudit(approvalId, 'orchestrator_review', 'orchestrator', summary, {
    findings: findings.length > 0 ? findings : undefined,
    reviewer: 'orchestrator',
    approved,
    patterns: patterns.length > 0 ? patterns : undefined,
    conflictZones: conflictZones.length > 0 ? conflictZones : undefined,
  });

  if (!lane.packetId || !lane.sessionKey) {
    return;
  }

  try {
    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    await capturePacketCompletionContext(lane.packetId, lane.sessionKey);
  } catch (error) {
    console.error(`[context-relay] Failed to refresh reviewed packet context for ${lane.packetId}:`, error);
  }
}

function buildLanePolicyContext(
  lane: Pick<Lane, 'id' | 'repoPath'>,
  verb: 'create_pr' | 'merge',
  actor: LaneEventActor,
  opts?: {
    orchestratorReviewed?: boolean;
    fileSizeLimitExceeded?: boolean;
    gatePassed?: boolean;
    hasApprovedReview?: boolean;
  },
) {
  // Auto-approve only when the orchestrator has a durable, HEAD-matched,
  // approved orchestrator_review row. In-progress auto-review, advisory
  // orchestratorReviewed, and gatePassed no longer authorize by themselves.
  const autoReview = actor === 'orchestrator' && opts?.hasApprovedReview === true;
  return buildPolicyContext('lane_command', {
    verb,
    laneId: lane.id,
    autoReview,
    fileSizeLimitExceeded: opts?.fileSizeLimitExceeded === true,
  }, {
    workspacePath: lane.repoPath,
  });
}

// Retained pending removal: this status flag is no longer merge authorization.
function isLaneAutoReviewInProgress(laneId: string) {
  try {
    const row = getSqlite()
      .prepare(`SELECT 1 FROM review_queue WHERE lane_id = ? AND status = 'in_progress' LIMIT 1`)
      .get(laneId);
    return Boolean(row);
  } catch {
    return false;
  }
}

async function createLaneActionApproval(
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
    gateResult?: import('@/lib/approvals/types').ApprovalGateResult;
    conflictReport?: import('@/lib/approvals/types').ApprovalConflictReport;
    strategy?: import('@/lib/approvals/types').MergeStrategy;
  },
): Promise<LaneCommandResult> {
  const rawDiff = await getDiffForLane(lane);
  const files = parseGitDiff(rawDiff);
  const approval = createApproval({
    source: 'runtime',
    runtime: lane.runtime,
    agent: lane.label || lane.branch,
    sessionKey: lane.sessionKey || `lane:${lane.id}`,
    title: input.title,
    description: input.description,
    summary: input.summary,
    diff: {
      path: 'multi-file',
      after: rawDiff || undefined,
      files,
    },
    gateResult: input.gateResult,
    conflictReport: input.conflictReport,
    risk: input.risk,
    policyRuleId: input.policyRuleId,
    metadata: {
      Lane: lane.id,
      Branch: lane.branch,
      Base: lane.baseBranch,
      Runtime: lane.runtime,
      ...(lane.packetId ? { Packet: lane.packetId } : {}),
      ...(input.expectedHeadSha ? { 'Expected HEAD': input.expectedHeadSha } : {}),
      ...input.metadata,
    },
    continuation: {
      kind: 'lane',
      laneId: lane.id,
      verb: input.verb,
      commitMessage: input.commitMessage,
      expectedHeadSha: input.expectedHeadSha,
      strategy: input.strategy,
    },
  });
  await recordReviewLessonsForApproval(approval.id, lane, input.reviewSummary, files);
  setLaneStatus(lane.id, 'awaiting_input', actor, 'approval_required');
  void publishRealtimeMutation({
    mutation: {
      mutationId: `approval-create-${approval.id}`,
      source: 'desktop',
      action: 'approve',
      sessionKey: approval.sessionKey,
      surfaceId: approval.sessionKey,
      status: 'pending',
      note: `Approval required: ${approval.title}`,
      createdAt: new Date().toISOString(),
    },
    refreshTargets: ['global', 'mobileInbox'],
    sessionKeys: [approval.sessionKey],
    fresh: true,
  });
  return { ok: false, laneId: lane.id, note: input.note, approvalId: approval.id };
}

/**
 * #2 Stage 5b — worker-context merge governance. A dispatched worker that calls
 * `o8 packet approve-merge` cannot merge its own work to main; this raises an
 * operator approval card (the SAME primitive + lane-merge continuation as the
 * file-size gate above). When the operator approves it, /api/panel/approvals
 * dispatches the continuation through the full merge gate. Capability symmetry
 * for the agent, the review-inversion moat intact for the operator.
 */
export async function raiseWorkerMergeApproval(
  lane: Lane,
  input: { commitMessage?: string; expectedHeadSha?: string; reviewSummary?: string } = {},
): Promise<LaneCommandResult> {
  return createLaneActionApproval(lane, 'orchestrator', {
    verb: 'merge',
    commitMessage: input.commitMessage,
    expectedHeadSha: input.expectedHeadSha,
    reviewSummary: input.reviewSummary,
    title: 'Worker requested merge to main',
    description: 'A dispatched worker reached the merge step via `o8 packet approve-merge`. Per governance a worker cannot merge its own work to main — approve to run the merge through the gate, or reject to send it back.',
    summary: `Worker merge request: ${lane.branch} → ${lane.baseBranch}`,
    risk: 'medium',
    policyRuleId: 'worker-merge-governance',
    note: 'Worker-initiated merge held for operator approval.',
  });
}

export async function dispatch(command: LaneCommand): Promise<LaneCommandResult> {
  const actor: LaneEventActor = command.actor ?? 'user';

  switch (command.verb) {
    case 'open_lane': {
      const workerRouting = resolveWorkerRouting({
        requestedRuntime: command.runtime,
        source: 'lane-open',
      });
      const existing = (await import('@/lib/lane/registry')).findLaneByRepoAndBranch(
        command.repoPath,
        command.branch,
      );
      if (existing) {
        if (!listDispatchableRuntimes({ includeExperimental: true }).includes(existing.runtime)) {
          return {
            ok: false,
            laneId: existing.id,
            note: `Runtime "${existing.runtime}" is not dispatchable (existing lane ${existing.id}). Dispatchable: ${listDispatchableRuntimes({ includeExperimental: true }).join(', ')}. Archive or migrate the lane before launching new work.`,
            lane: existing,
          };
        }
        const updatedExisting = command.packetId && existing.packetId !== command.packetId
          ? updateLane(existing.id, { packetId: command.packetId }, actor) ?? existing
          : existing;
        return { ok: true, laneId: updatedExisting.id, note: 'Lane already exists for this repo and branch.', lane: updatedExisting };
      }

      const lane = createLane({
        repoPath: command.repoPath,
        projectId: command.projectId,
        branch: command.branch,
        baseBranch: command.baseBranch,
        runtime: workerRouting.selectedRuntime,
        label: command.label,
        packetId: command.packetId,
        ownership: command.ownership,
        actor,
      });

      return { ok: true, laneId: lane.id, note: `Lane opened: ${lane.label}. ${workerRouting.reason}`, lane };
    }

    case 'bind_worktree': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      const updated = updateLane(
        command.laneId,
        { worktreePath: command.worktreePath },
        actor,
      );
      return { ok: true, laneId: command.laneId, note: `Worktree bound: ${command.worktreePath}`, lane: updated ?? undefined };
    }

    case 'launch_session': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!listDispatchableRuntimes({ includeExperimental: true }).includes(lane.runtime)) {
        return {
          ok: false,
          laneId: command.laneId,
          note: `Runtime "${lane.runtime}" is not dispatchable. Dispatchable: ${listDispatchableRuntimes({ includeExperimental: true }).join(', ')}.`,
          lane,
        };
      }

      const policy = getLanePolicy(lane.branch);
      if (!policy.branchWritable && !policy.requiresApproval) {
        return { ok: false, laneId: command.laneId, note: `Branch ${lane.branch} is not writable.` };
      }

      // Bound launch attempts. Count prior `launching` transitions for this lane;
      // past the cap, fail terminally so the scheduler stops re-dispatching
      // (getDispatchBlocker treats 'failed' as a hard stop and the
      // 'launch_attempts_exhausted' label is outside its launch_error retry set).
      const priorLaunchAttempts = getLaneEvents(command.laneId, 200).filter(
        (event) => event.verb === 'status_change' && event.payload?.status === 'launching',
      ).length;
      if (priorLaunchAttempts >= LAUNCH_ATTEMPT_CAP) {
        setLaneStatus(command.laneId, 'failed', 'system', 'launch_attempts_exhausted');
        // #1293 self-clean: drop the session binding on terminal exhaustion so
        // the dead owned-session(s) from the failed attempts become orphans the
        // continuous sweep archives — instead of lingering bound to this lane,
        // inflating the agent count. The lane stays 'failed' (visible) so the
        // operator can still see it and reset to retry. Retryable failures
        // (launch_failed / launch_error → 'idle') keep their binding untouched.
        try {
          updateLane(command.laneId, { sessionKey: null }, 'system');
        } catch (err) {
          console.warn(`[lane] Failed to clear session binding on exhausted lane ${command.laneId}:`, err);
        }
        return {
          ok: false,
          laneId: command.laneId,
          note: `Launch failed ${priorLaunchAttempts}× — giving up. Reset the packet to retry.`,
        };
      }

      // Fail fast if the working directory is gone (deleted temp dir / pruned
      // worktree). Spawning into a nonexistent cwd just errors and loops.
      const launchCwd = lane.worktreePath ?? lane.repoPath;
      if (launchCwd && !existsSync(launchCwd)) {
        setLaneStatus(command.laneId, 'failed', 'system', 'launch_aborted_missing_cwd');
        return {
          ok: false,
          laneId: command.laneId,
          note: `Working directory no longer exists: ${launchCwd}. Reset the packet to re-provision.`,
        };
      }

      setLaneStatus(command.laneId, 'launching', actor, 'launching_session');

      // #1522 — a lane launching into an ALREADY-BOUND worktree skips the
      // create-time pre-launch rebase entirely (isolate:false below), so a
      // worktree provisioned earlier (queued dispatch:false mission, failed
      // prior attempt) dispatched against its create-time base snapshot — and
      // the resulting branch diffed everything merged in between as
      // DELETIONS. Refresh the existing worktree onto current origin/base
      // before every launch into it. A conflict means the branch carries real
      // prior work against a moved base — proceed on the old base with an
      // audit event (the worker/reviewer sees it); the dangerous zero-work
      // stale snapshot always fast-forwards clean.
      // Adversarial F12 — realpath-normalize before comparing: a symlinked or
      // trailing-slash worktreePath equal to the primary checkout must never
      // let the refresh rebase the OPERATOR's working tree.
      const refreshTarget = (() => {
        if (!lane.worktreePath) return null;
        try {
          const wt = realpathSync(lane.worktreePath);
          return wt === realpathSync(lane.repoPath) ? null : wt;
        } catch {
          return null; // unresolvable path — the missing-cwd guard above already handles it
        }
      })();
      if (refreshTarget) {
        try {
          const { getWorktreeManager } = await import('@/lib/worktree');
          await getWorktreeManager(lane.repoPath).rebaseOntoMain(refreshTarget, {
            baseBranch: lane.baseBranch,
            branchName: lane.branch,
          });
          appendEvent(command.laneId, 'worktree_refreshed', 'system', {
            packetId: lane.packetId,
            baseBranch: lane.baseBranch,
            note: `Existing worktree rebased onto current origin/${lane.baseBranch} before launch.`,
          });
        } catch (err) {
          const note = err instanceof Error ? err.message : String(err);
          appendEvent(command.laneId, 'worktree_refresh_failed', 'system', {
            packetId: lane.packetId,
            baseBranch: lane.baseBranch,
            note,
          });
          // Adversarial F11 — a conflict abort is best-effort inside the
          // manager; verify the tree is actually OUT of rebase state before
          // launching a worker into it. A half-rebased tree (conflict
          // markers, .git/rebase-merge) must park, not launch.
          const rebasing = ['rebase-merge', 'rebase-apply'].some((marker) => {
            try {
              return existsSync(join(refreshTarget, '.git', marker));
            } catch {
              return false;
            }
          });
          if (rebasing) {
            setLaneStatus(command.laneId, 'failed', 'system', 'worktree_mid_rebase');
            return {
              ok: false,
              laneId: command.laneId,
              note: `Worktree at ${refreshTarget} is stuck mid-rebase after a failed refresh (${note}). Reset the packet to re-provision.`,
            };
          }
          console.warn(`[lane] pre-launch worktree refresh failed for ${command.laneId} — launching on the existing base: ${note}`);
        }
      }

      try {
        const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
        const result = await launchRuntimeSurface({
          runtime: lane.runtime,
          prompt: command.prompt,
          repoPath: lane.worktreePath ?? lane.repoPath,
          projectRepoPath: lane.repoPath,
          // Bind the worktree to the lane's branch so the agent lands on
          // the correct branch from turn 0. Without this the manager fell
          // back to `worktree/<agent>/<slug>` and the agent had to self-
          // correct via `git checkout -b <lane.branch>` — weaker models
          // missed the hint and silently committed to the wrong branch.
          branchName: lane.branch,
          baseBranch: lane.baseBranch,
          model: command.model,
          effort: command.effort,
          isolate: !lane.worktreePath,
          skipSetup: true,
          existingLaneId: command.laneId,
          packetId: lane.packetId ?? undefined,
        });

        if (!result.ok) {
          setLaneStatus(command.laneId, 'idle', 'system', 'launch_failed');
          return { ok: false, laneId: command.laneId, note: result.note };
        }

        attachSession(command.laneId, result.surfaceId, actor);
        if (result.worktree?.path && !lane.worktreePath) {
          updateLane(command.laneId, { worktreePath: result.worktree.path }, 'system');
        }
        setLaneStatus(command.laneId, 'running', actor, 'session_launched');

        // Coarse product signal — an agent actually started working (#1249).
        // Runtime enum only; never the prompt/repo. Most dispatches come from the
        // orchestrator via MCP, not a UI button, so this server emit is the only
        // place the signal is observable. Fire-and-forget, never blocks dispatch.
        void emitProductEvent('dispatch.started', { runtime: lane.runtime });

        // Register with supervisor for completion detection + stuck monitoring.
        // The supervisor runs in the ws-server process — use HTTP, not direct import.
        try {
          const { wsPort } = resolvePortInfo();
          await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getOrCreateWsToken()}` },
            body: JSON.stringify({
              surfaceId: result.surfaceId,
              repoPath: lane.repoPath,
              name: lane.label || lane.branch,
              prompt: command.prompt,
            }),
            signal: AbortSignal.timeout(3000),
          });
        } catch (regErr) {
          console.warn(`[lane] Failed to register agent with supervisor:`, regErr);
        }

        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: result.note, lane: updated ?? undefined };
      } catch (err) {
        setLaneStatus(command.laneId, 'idle', 'system', 'launch_error');
        const message = err instanceof Error ? err.message : 'Launch failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'attach_session': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      const updated = attachSession(command.laneId, command.sessionKey, actor);
      return { ok: true, laneId: command.laneId, note: `Session attached: ${command.sessionKey}`, lane: updated ?? undefined };
    }

    case 'send_turn': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.sessionKey) return { ok: false, laneId: command.laneId, note: 'No active session on this lane.' };

      try {
        const { performRuntimeAction } = await import('@/lib/runtime/actions');
        const result = await performRuntimeAction({
          action: 'steer',
          surfaceId: lane.sessionKey,
          message: command.message,
        });

        if (result.ok) {
          rebindLaneSessionIfChanged(command.laneId, lane.sessionKey, result.sessionKey, actor);
          setLaneStatus(command.laneId, 'running', actor, 'turn_sent');
        }

        return { ok: result.ok, laneId: command.laneId, note: result.note, lane: getLane(command.laneId) ?? undefined };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Send failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'interrupt': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.sessionKey) return { ok: false, laneId: command.laneId, note: 'No active session to interrupt.' };

      try {
        const { performRuntimeAction } = await import('@/lib/runtime/actions');
        const result = await performRuntimeAction({
          action: 'interrupt',
          surfaceId: lane.sessionKey,
        });

        if (result.ok) {
          setLaneStatus(command.laneId, 'paused', actor, 'interrupted');
        }

        return { ok: result.ok, laneId: command.laneId, note: result.note, lane: getLane(command.laneId) ?? undefined };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Interrupt failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'stop': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      // 1) Flag the packet operator-stopped FIRST, inside the control-plane lock.
      //    The order is the correctness point: interrupting the session can end it
      //    and trip a stall/ralph requeue, and a concurrent dispatch tick reads
      //    state under the same lock — setting operatorStopped + held atomically
      //    here means getDispatchBlocker rejects every relaunch path before the
      //    interrupt can race a re-dispatch in. (2026-06-22)
      if (lane.packetId) {
        try {
          const { withLockedState } = await import('@/lib/orchestrator/control-plane');
          await withLockedState((state) => {
            const packet = state.packets.find((candidate) => candidate.id === lane.packetId);
            if (!packet) return;
            packet.operatorStopped = true;
            packet.queueState = 'held';
            packet.status = 'blocked';
            packet.blockedReason = 'operator_stopped';
            packet.lastEventAt = new Date().toISOString();
            packet.lastEventLabel = 'operator_stopped';
          });
        } catch (err) {
          console.warn('[lane] stop: could not mark packet operator-stopped', err);
        }
      }

      // 2) Interrupt the live session if one exists. Truthful status matters:
      //    only show paused after the runtime confirms the worker is gone.
      let stopOk = true;
      let stopNote = 'No active session was attached.';
      if (lane.sessionKey) {
        try {
          const { performRuntimeAction } = await import('@/lib/runtime/actions');
          const result = await performRuntimeAction({ action: 'stop', surfaceId: lane.sessionKey });
          stopOk = result.ok || result.status === 'completed';
          stopNote = result.note;
        } catch (err) {
          stopOk = false;
          stopNote = err instanceof Error ? err.message : 'Interrupt failed.';
        }
      }

      if (!stopOk) {
        appendEvent(command.laneId, 'interrupt_failed', actor, {
          packetId: lane.packetId,
          sessionKey: lane.sessionKey,
          note: stopNote,
        });
        setLaneStatus(command.laneId, 'running', actor, 'interrupt_failed');
        return {
          ok: false,
          laneId: command.laneId,
          note: `Stop guard is held, but the live worker did not exit: ${stopNote}`,
          lane: getLane(command.laneId) ?? undefined,
        };
      }

      setLaneStatus(command.laneId, 'paused', actor, 'operator_stopped');
      return {
        ok: true,
        laneId: command.laneId,
        note: 'Agent stopped. It will not auto-redispatch — reset or relaunch to continue.',
        lane: getLane(command.laneId) ?? undefined,
      };
    }

    case 'resume': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      // If lane has a live session, resume it with a message
      if (lane.sessionKey && command.message) {
        try {
          const { performRuntimeAction } = await import('@/lib/runtime/actions');
          const result = await performRuntimeAction({
            action: 'steer',
            surfaceId: lane.sessionKey,
            message: command.message,
          });
          if (result.ok) {
            rebindLaneSessionIfChanged(command.laneId, lane.sessionKey, result.sessionKey, actor);
            setLaneStatus(command.laneId, 'running', actor, 'resumed');
          }
          return { ok: result.ok, laneId: command.laneId, note: result.note, lane: getLane(command.laneId) ?? undefined };
        } catch {
          // Session dead — fall through to re-launch
        }
      }

      // No session or session dead — re-launch in the same worktree
      const prompt = command.message || 'Continue the previous task. Check what was done and what remains.';
      setLaneStatus(command.laneId, 'launching', actor, 'relaunching');

      try {
        const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
        const result = await launchRuntimeSurface({
          runtime: lane.runtime,
          prompt,
          repoPath: lane.worktreePath ?? lane.repoPath,
          projectRepoPath: lane.repoPath,
          baseBranch: lane.baseBranch,
          isolate: false,
          skipSetup: true,
          existingLaneId: command.laneId,
          packetId: lane.packetId ?? undefined,
        });

        if (!result.ok) {
          setLaneStatus(command.laneId, 'paused', 'system', 'relaunch_failed');
          return { ok: false, laneId: command.laneId, note: result.note };
        }

        attachSession(command.laneId, result.surfaceId, actor);
        setLaneStatus(command.laneId, 'running', actor, 'resumed');

        // Register with supervisor (ws-server process) via HTTP
        try {
          const { wsPort } = resolvePortInfo();
          await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getOrCreateWsToken()}` },
            body: JSON.stringify({ surfaceId: result.surfaceId, repoPath: lane.repoPath, name: lane.label || lane.branch, prompt }),
            signal: AbortSignal.timeout(3000),
          });
        } catch { /* best effort */ }

        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: `Resumed in ${lane.worktreePath ?? lane.repoPath}.`, lane: updated ?? undefined };
      } catch (err) {
        setLaneStatus(command.laneId, 'paused', 'system', 'relaunch_error');
        const message = err instanceof Error ? err.message : 'Resume failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'request_review': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      // #454 — Guard: auto-commit dirty worktrees before allowing review transition
      const reviewCwd = lane.worktreePath ?? lane.repoPath;
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: reviewCwd,
          maxBuffer: 10 * 1024 * 1024,
        });
        if (porcelain.trim().length > 0) {
          console.log(`[lane] request_review: dirty worktree detected in ${reviewCwd}, auto-committing`);
          await execFileAsync('git', ['add', '-A', '--', '.'], {
            cwd: reviewCwd,
            maxBuffer: 10 * 1024 * 1024,
          });
          // Unstage o8-injected worktree artifacts so they never land in the review
          // commit: the safety-hook `.claude/settings.json` (otherwise blows the
          // diff-budget merge gate) and the `node_modules` symlink (otherwise pollutes
          // the target repo's main). Use `git reset` to unstage rather than a negative
          // `git add` pathspec — the latter errors ("paths are ignored") when an ignored
          // dir like node_modules exists in the worktree.
          await execFileAsync('git', ['reset', '-q', '--', '.claude', 'node_modules'], {
            cwd: reviewCwd,
            maxBuffer: 10 * 1024 * 1024,
          });
          await execFileAsync('git', ['commit', '-m', 'auto-commit: agent work before review'], {
            cwd: reviewCwd,
            maxBuffer: 10 * 1024 * 1024,
          });
        }
      } catch (err) {
        console.warn(`[lane] request_review: git status/commit check failed for ${reviewCwd}:`, err);
        // Non-fatal — proceed with the review transition even if the commit check fails
      }

      // Empty-commit guard — if the worktree has zero commits ahead of base
      // AND the working tree is clean, the runtime reported success but produced
      // no diff. Surface this as a failed lane with a clear note instead of
      // opening an empty review packet. (Observed with Gemini 3.1 Pro: emitted
      // a clean <self-review> block but never actually landed a commit.)
      try {
        const baseBranch = lane.baseBranch || 'main';
        const probe = await probeNoChangesProduced(reviewCwd, baseBranch);
        if (probe.noChangesProduced) {
          const { parkHuddleReadyZeroDiffLane } = await import('@/lib/orchestrator/huddle-zero-diff');
          const huddlePark = await parkHuddleReadyZeroDiffLane(lane);
          if (huddlePark.parked) {
            console.warn(`[lane] request_review: ${command.laneId} produced no diff after huddle report — parking for orchestrator.`);
            return {
              ok: false,
              laneId: command.laneId,
              note: 'huddle_ready',
              lane: huddlePark.lane ?? undefined,
            };
          }
          console.warn(`[lane] request_review: ${command.laneId} has 0 commits ahead of ${baseBranch} — runtime reported success but produced no diff. Marking failed.`);
          const failed = setLaneStatus(command.laneId, 'failed', 'system', 'zero_diff_failed');
          return {
            ok: false,
            laneId: command.laneId,
            note: 'no_changes_produced',
            lane: failed ?? undefined,
          };
        }
      } catch (err) {
        console.warn(`[lane] request_review: empty-commit check failed for ${reviewCwd}:`, err);
        // Non-fatal — proceed; the review panel will show an empty diff at worst
      }

      const updated = setLaneStatus(command.laneId, 'reviewing', actor, 'review_requested');
      return { ok: true, laneId: command.laneId, note: 'Review requested.', lane: updated ?? undefined };
    }

    case 'create_pr': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.worktreePath) return { ok: false, laneId: command.laneId, note: 'No worktree to create PR from. Lane is on the main working tree.' };

      // Policy gate — require approval for PR creation
      const hasApprovedReview = actor === 'user' ? true : await hasDurableApprovedReview(lane);
      const prPolicy = evaluatePolicy(buildLanePolicyContext(lane, 'create_pr', actor, {
        hasApprovedReview,
      }));
      if (prPolicy.requiresApproval && actor !== 'user') {
        return createLaneActionApproval(lane, actor, {
          verb: 'create_pr',
          commitMessage: command.commitMessage,
          reviewSummary: command.reviewSummary,
          title: 'Create pull request',
          description: command.reviewSummary || `Create PR from lane "${lane.label}" (${lane.branch} → ${lane.baseBranch})`,
          summary: `Create PR: ${lane.branch} → ${lane.baseBranch}`,
          risk: prPolicy.risk,
          policyRuleId: prPolicy.ruleId,
          note: `Approval required: ${prPolicy.reason}`,
        });
      }

      if (prPolicy.ruleId === 'auto_approve_orchestrator_review') {
        console.log(`[headless] Auto-approved orchestrator review for lane ${lane.id} (create_pr)`);
      }

      setLaneStatus(command.laneId, 'merging', actor, 'creating_pr');

      try {
        if (!lane.worktreePath || !(await worktreeExistsOnDisk(lane.worktreePath))) {
          setLaneStatus(command.laneId, 'reviewing', 'system', 'worktree_not_found');
          return {
            ok: false,
            laneId: command.laneId,
            note: `Worktree not found on disk: ${lane.worktreePath ?? '<unset>'}`,
          };
        }

        // Commit any uncommitted changes first.
        // F32 (#1024): match the merge-path fix — only commit when there are
        // real uncommitted changes. --allow-empty here created duplicate
        // commits on every create_pr call when Codex had already committed.
        if (command.commitMessage) {
          try {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile);
            await execFileAsync('git', ['add', '-A'], { cwd: lane.worktreePath });
            const { stdout: porcelain } = await execFileAsync(
              'git', ['status', '--porcelain'],
              { cwd: lane.worktreePath, timeout: 5000 },
            );
            if (porcelain.trim()) {
              await execFileAsync('git', ['commit', '-m', command.commitMessage], { cwd: lane.worktreePath });
            }
          } catch {
            // May fail if nothing to commit — that's fine
          }
        }

        // Push branch
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        await execFileAsync('git', ['push', '-u', 'origin', lane.branch], { cwd: lane.worktreePath });

        // Create PR via gh CLI
        const prTitle = lane.label || `${lane.branch}`;
        const prResult = await execFileAsync('gh', [
          'pr', 'create',
          '--base', lane.baseBranch,
          '--head', lane.branch,
          '--title', prTitle,
          '--body', command.reviewSummary?.trim() || `Automated PR from lane \`${lane.id}\`.\n\nRuntime: ${lane.runtime}\nPacket: ${lane.packetId ?? 'none'}`,
        ], { cwd: lane.repoPath });

        const prUrl = prResult.stdout.trim();
        const prNumber = parsePullRequestNumber(prUrl);
        updateLane(command.laneId, {
          ...(prNumber !== null ? { prNumber } : {}),
          outcome: 'pr_opened',
          outcomeNote: `Pull request opened: ${prUrl}`,
        }, actor);
        setLaneStatus(command.laneId, 'reviewing', actor, 'pr_created');
        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: `PR created: ${prUrl}`, lane: updated ?? undefined };
      } catch (err) {
        setLaneStatus(command.laneId, 'reviewing', 'system', 'pr_failed');
        const message = err instanceof Error ? err.message : 'PR creation failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'merge': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      // #1173 — PR-only wall: refuse merge while the autonomous dogfood loop is driving.
      if (dogfoodPrOnlyActive()) return { ok: false, laneId: command.laneId, note: DOGFOOD_PR_ONLY_NOTE };
      const isRemoteCustomerLane = (lane.runtime as string) === 'remote-customer';
      if (!lane.worktreePath && !isRemoteCustomerLane) {
        return { ok: false, laneId: command.laneId, note: 'No worktree to merge. Lane is on the main working tree.' };
      }

      const oversizedFiles = await getOversizedChangedFilesForLane(lane);
      if (oversizedFiles.length > 0) {
        const largestFile = oversizedFiles[0];
        const fileSizePolicy = evaluatePolicy(buildLanePolicyContext(lane, 'merge', actor, {
          orchestratorReviewed: command.orchestratorReviewed,
          fileSizeLimitExceeded: true,
        }));

        if (fileSizePolicy.requiresApproval && actor !== 'user') {
          return createLaneActionApproval(lane, actor, {
            verb: 'merge',
            commitMessage: command.commitMessage,
            expectedHeadSha: command.expectedHeadSha,
            reviewSummary: command.reviewSummary,
            title: 'Override file size limit',
            description: `Merge blocked by file size governance. Oversized changed file${oversizedFiles.length === 1 ? '' : 's'}: ${formatOversizedFiles(oversizedFiles)}. Operator approval is required to override.`,
            summary: `File size limit override: ${lane.branch} → ${lane.baseBranch}`,
            risk: fileSizePolicy.risk,
            policyRuleId: fileSizePolicy.ruleId,
            metadata: {
              'File path': oversizedFiles.length === 1
                ? largestFile.path
                : `${largestFile.path} (+${oversizedFiles.length - 1} more)`,
              'Current line count': String(largestFile.lineCount),
              'Original line count': largestFile.originalLineCount === null ? 'unknown' : String(largestFile.originalLineCount),
              'Net line change': largestFile.originalLineCount === null ? 'unknown' : String(largestFile.lineCount - largestFile.originalLineCount),
              Threshold: String(FILE_SIZE_BLOCK_THRESHOLD_LINES),
            },
            note: `Approval required: ${fileSizePolicy.reason}`,
          });
        }
      }

      // ── Merge gate enforcement ──
      // Runs security, budget, and integrity checks. Block-level violations
      // force human approval regardless of auto-review status.
      //
      // When the orchestrator has already approved the review, pass that
      // through — the gate downgrades budget violations to warn so a
      // human-in-the-loop refactor with intentional large deletions can
      // land. Security + integrity always stay block-level. See F25 / #1001.
      const gateResult = await runMergeGate(lane, undefined, command.orchestratorReviewed === true);
      if (!gateResult.passed && actor !== 'user') {
        const blockCount = gateResult.violations.filter((v) => v.severity === 'block').length;
        return createLaneActionApproval(lane, actor, {
          verb: 'merge',
          commitMessage: command.commitMessage,
          expectedHeadSha: command.expectedHeadSha,
          reviewSummary: command.reviewSummary,
          title: `Merge gate: ${blockCount} violation${blockCount === 1 ? '' : 's'}`,
          description: formatMergeGateViolations(gateResult.violations),
          summary: `Merge blocked: ${lane.branch} → ${lane.baseBranch}`,
          risk: 'high',
          policyRuleId: 'merge-gate-violation',
          note: 'Merge gate enforcement: human review required.',
          gateResult: { passed: gateResult.passed, violations: gateResult.violations, diffBase: gateResult.diffBase },
        });
      }

      // Durable approved-review precondition. Computed after the merge gate so
      // block-level gate findings still force an operator card regardless of review.
      const hasApprovedReview = actor === 'user' ? true : await hasDurableApprovedReview(lane);

      // Policy gate — require approval for merge
      const mergePolicy = evaluatePolicy(buildLanePolicyContext(lane, 'merge', actor, {
        orchestratorReviewed: command.orchestratorReviewed,
        gatePassed: gateResult.passed,
        hasApprovedReview,
      }));
      if (mergePolicy.requiresApproval && actor !== 'user') {
        return createLaneActionApproval(lane, actor, {
          verb: 'merge',
          commitMessage: command.commitMessage,
          expectedHeadSha: command.expectedHeadSha,
          reviewSummary: command.reviewSummary,
          title: 'Merge lane',
          description: command.reviewSummary || `Merge lane "${lane.label}" (${lane.branch} → ${lane.baseBranch})`,
          summary: `Merge: ${lane.branch} → ${lane.baseBranch}`,
          risk: mergePolicy.risk,
          policyRuleId: mergePolicy.ruleId,
          note: `Approval required: ${mergePolicy.reason}`,
        });
      }

      if (mergePolicy.ruleId === 'auto_approve_orchestrator_review') {
        console.log(`[headless] Auto-approved orchestrator review for lane ${lane.id} (merge)`);
      }

      setLaneStatus(command.laneId, 'merging', actor, 'merging');

      if (isRemoteCustomerLane) {
        return performRemoteCustomerMerge(lane, command, actor);
      }

      const worktreePath = lane.worktreePath;
      if (!worktreePath) {
        return { ok: false, laneId: command.laneId, note: 'No worktree to merge. Lane is on the main working tree.' };
      }

      if (!(await worktreeExistsOnDisk(worktreePath))) {
        setLaneStatus(command.laneId, 'reviewing', 'system', 'worktree_not_found');
        return {
          ok: false,
          laneId: command.laneId,
          note: `Worktree not found on disk: ${worktreePath}`,
        };
      }

      return performWorktreeSideMerge({
        lane,
        command,
        actor,
        gateResult: { passed: gateResult.passed, violations: gateResult.violations },
        createLaneActionApproval,
      });
    }

    case 'complete': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      if (isProtectedBranch(lane.baseBranch) && lane.worktreePath) {
        // Protected target — require PR instead of direct complete
        setLaneStatus(command.laneId, 'reviewing', actor, 'review_required');
        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: 'Protected branch. Use create_pr or merge to complete.', lane: updated ?? undefined };
      }

      const updated = setLaneStatus(command.laneId, 'completed', actor, 'completed');
      return { ok: true, laneId: command.laneId, note: 'Lane completed.', lane: updated ?? undefined };
    }

    case 'archive': {
      const updated = archiveLane(command.laneId, actor);
      if (!updated) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      return { ok: true, laneId: command.laneId, note: 'Lane archived.', lane: updated };
    }

    default: {
      const _exhaustive: never = command;
      return { ok: false, laneId: '', note: `Unknown verb: ${(_exhaustive as LaneCommand).verb}` };
    }
  }
}

function formatLaneCommandError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '').trim() : '';
  const stdout = 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '').trim() : '';

  return stderr || stdout || error.message;
}

async function performRemoteCustomerMerge(
  lane: Lane,
  command: MergeCommand,
  actor: LaneEventActor,
): Promise<LaneCommandResult> {
  // #1173 — PR-only wall: refuse merge while the autonomous dogfood loop is driving.
  if (dogfoodPrOnlyActive()) return { ok: false, laneId: command.laneId, note: DOGFOOD_PR_ONLY_NOTE };
  const workerRun = fetchWorkerRun(lane.id);
  if (!workerRun?.remoteBranch) {
    setLaneStatus(command.laneId, 'reviewing', 'system', 'remote_branch_missing');
    return { ok: false, laneId: command.laneId, note: 'No remote branch recorded for this lane.' };
  }

  const fetched = await fetchWorkerBranch(lane.repoPath, workerRun.remoteBranch, workerRun.id);
  if (!fetched.ok) {
    console.warn(`[remote-merge] ${fetched.note}`);
    setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_error');
    return { ok: false, laneId: command.laneId, note: fetched.note };
  }

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  let savedBranch: string | null = null;

  try {
    savedBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: lane.repoPath,
      maxBuffer: 1024 * 1024,
    })).stdout.trim();

    if (command.commitMessage) {
      try {
        // F32 (#1024): same fix as the local-merge path. --allow-empty here
        // created duplicate commits when the remote worker had already
        // committed. Porcelain check first, commit only when dirty.
        await execFileAsync('git', ['add', '-A'], { cwd: fetched.tempWorktreePath });
        const { stdout: porcelain } = await execFileAsync(
          'git', ['status', '--porcelain'],
          { cwd: fetched.tempWorktreePath, timeout: 5000 },
        );
        if (porcelain.trim()) {
          await execFileAsync('git', ['commit', '-m', command.commitMessage], {
            cwd: fetched.tempWorktreePath,
          });
        }
      } catch { /* nothing to commit */ }
    }

    const actualBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: fetched.tempWorktreePath,
      maxBuffer: 1024 * 1024,
    })).stdout.trim();
    console.log(`[remote-merge] Actual worktree branch: ${actualBranch} (base ref: ${fetched.baseRef})`);

    let rebaseFailed = false;
    try {
      await execFileAsync('git', ['rebase', lane.baseBranch], { cwd: fetched.tempWorktreePath });
      console.log(`[remote-merge] Rebased ${actualBranch} onto ${lane.baseBranch}`);
    } catch {
      try {
        await execFileAsync('git', ['rebase', '--abort'], { cwd: fetched.tempWorktreePath });
      } catch {
        // already clean
      }
      rebaseFailed = true;
      console.log(`[remote-merge] Rebase failed for ${actualBranch}, attempting direct merge`);
    }

    if (!rebaseFailed) {
      const typecheck = await runLaneRebaseTypecheck({
        cwd: fetched.tempWorktreePath,
        actualBranch,
        logPrefix: 'remote-merge',
      });
      if (!typecheck.ok) {
        setLaneStatus(command.laneId, 'reviewing', 'system', 'typecheck_failed');
        return {
          ok: false,
          laneId: command.laneId,
          note: `Typecheck failed after rebase onto ${lane.baseBranch}. Fix type errors before merging.\n\n${typecheck.output}`,
        };
      }
    }

    if (command.strategy === 'manual') {
      setLaneStatus(command.laneId, 'reviewing', 'system', 'manual_resolution_unsupported');
      return {
        ok: false,
        laneId: command.laneId,
        note: 'Manual conflict resolution is not supported for remote-customer merges.',
      };
    }

    await execFileAsync('git', ['checkout', lane.baseBranch], { cwd: lane.repoPath });

    try {
      const mergeArgs = ['merge', '--no-ff', '-m', `Merge lane ${lane.label} (${actualBranch})`];
      if (command.strategy === 'ours' || command.strategy === 'theirs') {
        mergeArgs.push('-X', command.strategy);
      }
      mergeArgs.push(actualBranch);
      await execFileAsync('git', mergeArgs, { cwd: lane.repoPath });
    } catch (mergeErr) {
      let conflictFiles: string[] = [];
      try {
        const { stdout: unmerged } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], {
          cwd: lane.repoPath,
        });
        conflictFiles = unmerged.trim().split('\n').filter(Boolean);
      } catch {
        // best effort
      }

      try {
        await execFileAsync('git', ['merge', '--abort'], { cwd: lane.repoPath });
      } catch {
        // already clean
      }

      const mergeMessage = formatLaneCommandError(mergeErr);
      const conflictLabel = rebaseFailed
        ? `Rebase failed, merge also failed: ${mergeMessage}`
        : `Merge failed after rebase: ${mergeMessage}`;
      const conflictSuffix = conflictFiles.length > 0
        ? `\n\nConflicting files:\n${conflictFiles.map((file) => `- ${file}`).join('\n')}`
        : '';
      console.warn(`[remote-merge] ${conflictLabel}`);
      setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_conflict');
      return {
        ok: false,
        laneId: command.laneId,
        note: `${conflictLabel}${conflictSuffix}`,
      };
    }

    let pushedToOrigin = false;
    let pushError: string | undefined;
    try {
      await execFileAsync('git', ['push', 'origin', lane.baseBranch], {
        cwd: lane.repoPath,
        timeout: 60_000,
      });
      pushedToOrigin = true;
      console.log(`[remote-merge] Pushed ${lane.baseBranch} to origin after merging ${actualBranch}`);
    } catch (pushErr) {
      pushError = formatLaneCommandError(pushErr);
      console.warn(`[remote-merge] Push to origin failed for ${lane.baseBranch} after merging ${actualBranch}: ${pushError}`);
    }

    try {
      await execFileAsync('git', ['push', 'origin', '--delete', workerRun.remoteBranch], {
        cwd: lane.repoPath,
        timeout: 60_000,
      });
      console.log(`[remote-merge] Deleted remote branch ${workerRun.remoteBranch}`);
    } catch (deleteErr) {
      console.warn(
        `[remote-merge] Failed to delete remote branch ${workerRun.remoteBranch}: ${formatLaneCommandError(deleteErr)}`,
      );
    }

    setLaneStatus(command.laneId, 'completed', actor, pushedToOrigin ? 'merged_pushed' : 'merged');

    let decompositionNote = '';
    try {
      const { enqueueDecompositionsAfterMerge } = await import('@/lib/dispatch/decomposition-pipeline');
      const decomposition = await enqueueDecompositionsAfterMerge({
        repoPath: lane.repoPath,
        runtime: lane.runtime,
      });
      if (decomposition.enqueued > 0) {
        const names = decomposition.candidates
          .map((candidate) => candidate.relativePath)
          .join(', ');
        decompositionNote = ` Enqueued ${decomposition.enqueued} decomposition dispatch${decomposition.enqueued === 1 ? '' : 'es'} for over-ceiling file${decomposition.enqueued === 1 ? '' : 's'}: ${names}.`;
      }
    } catch (decompositionError) {
      console.warn(
        `[remote-merge] Decomposition scan failed for ${lane.repoPath}: ${decompositionError instanceof Error ? decompositionError.message : String(decompositionError)}`,
      );
    }

    const updated = getLane(command.laneId);
    const mergeNote = pushedToOrigin
      ? `Merged ${lane.branch} into ${lane.baseBranch} and pushed to origin.${decompositionNote}`
      : `Merged ${lane.branch} into ${lane.baseBranch} LOCALLY — push to origin failed: ${pushError ?? 'unknown error'}. Run \`git push origin ${lane.baseBranch}\` to ship the commit.${decompositionNote}`;
    return {
      ok: true,
      laneId: command.laneId,
      note: mergeNote,
      lane: updated ?? undefined,
      pushedToOrigin,
      pushError,
    };
  } catch (error) {
    const message = formatLaneCommandError(error);
    console.error(`[remote-merge] Merge failed for lane ${lane.id}: ${message}`);
    setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_error');
    return { ok: false, laneId: command.laneId, note: message };
  } finally {
    if (savedBranch) {
      try {
        await execFileAsync('git', ['checkout', savedBranch], { cwd: lane.repoPath });
      } catch (restoreError) {
        console.warn(`[remote-merge] Failed to restore branch ${savedBranch}: ${formatLaneCommandError(restoreError)}`);
      }
    }

    try {
      await cleanupRemoteMergeWorktree(fetched.tempWorktreePath);
    } catch (cleanupError) {
      console.warn(
        `[remote-merge] Failed to clean up temp worktree ${fetched.tempWorktreePath}: ${formatLaneCommandError(cleanupError)}`,
      );
    }
  }
}
