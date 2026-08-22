/**
 * Lane Domain Model
 *
 * A lane is the durable operator-facing unit in o8.
 * It binds purpose + repo + optional worktree + runtime + current session.
 *
 * Entity hierarchy:
 *   Repo → Worktree → Lane → Session → Tab
 *                       ↑
 *                     Packet
 *
 * Lanes persist across session rotations. A session may die and be replaced
 * without breaking the user's mental model of the work in progress.
 */

import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { OrchestratorRuntime, WorkerLaunchContext } from '@/lib/orchestrator/types';
import type { PacketSpendCap } from '@/lib/orchestrator/metered-spend';
import { isWorkerTerminal } from '@/lib/lane/terminal-states';

// ── Lane Status ──

/**
 * Lifecycle states a lane moves through from creation to archive.
 * Mirrors the user's mental model — they see status, not implementation details.
 */
export type LaneStatus =
  | 'idle'            // exists, no active work
  | 'launching'       // session being spawned
  | 'running'         // agent actively working
  | 'paused'          // agent idle, can resume
  | 'awaiting_input'  // agent needs a human decision
  | 'awaiting_orchestrator' // agent reported a blocker/question for o8
  | 'awaiting_human'  // layer-5 escalation: orchestrator gave up, operator must decide (NOT terminal)
  | 'recovering'      // agent/session died; operator can retry the packet
  | 'reviewing'       // work done, review needed
  | 'merging'         // merge in progress
  | 'failed'          // terminal failure, operator must redispatch or archive
  | 'completed'       // done and merged
  | 'archived';       // no longer active

const LANE_STATUS_RECORD = {
  idle: true,
  launching: true,
  running: true,
  paused: true,
  awaiting_input: true,
  awaiting_orchestrator: true,
  awaiting_human: true,
  recovering: true,
  reviewing: true,
  merging: true,
  failed: true,
  completed: true,
  archived: true,
} satisfies Record<LaneStatus, true>;

export const LANE_STATUSES = Object.keys(LANE_STATUS_RECORD) as LaneStatus[];

/** Terminal outcome of a lane's work — stamped once at the seam that ends
 *  the work (merge success, no-commit reconciliation, operator discard) so
 *  the rail can show truthful "what happened" chips after archive. */
export type LaneOutcome = 'no_changes' | 'merged' | 'discarded' | 'closed_unmerged' | 'pr_opened' | 'asked' | 'archived_recoverable';

/**
 * @deprecated Thin delegate kept for back-compat. The unified terminal-state
 * truth now lives in `lane/terminal-states.ts`. This predicate is the
 * WORKER-terminal notion (includes `reviewing`); call `isWorkerTerminal`
 * directly at new call sites, or `isLaneTerminal` when you mean the
 * lifecycle-over set.
 */
export function isTerminalLaneStatus(status: LaneStatus | null | undefined): boolean {
  return isWorkerTerminal(status);
}

/**
 * Managed = IDE spawned it, full control (steer, interrupt, review).
 * Attached = discovered existing session, inspect + capability-gated.
 */
export type LaneOwnership = 'managed' | 'attached';

// LaneRuntime intentionally mirrors OrchestratorRuntime so packets with any
// runtime can be routed through the lane system. The lane command bus
// dispatches to the correct CLI adapter at launch time.
export type LaneRuntime = OrchestratorRuntime;

// ── Lane ──

export interface Lane {
  id: string;
  projectId: string | null;
  label: string;
  repoPath: string;
  worktreePath: string | null;
  branch: string;
  baseBranch: string;
  runtime: LaneRuntime;
  sessionKey: string | null;
  packetId: string | null;
  prNumber: number | null;
  status: LaneStatus;
  outcome?: LaneOutcome | null;
  outcomeNote?: string | null;
  ownership: LaneOwnership;
  writerToken: string | null;
  lastHeartbeatAt: number | null;
  createdAt: string;
  updatedAt: string;
  lastEventAt: string | null;
  lastEventLabel: string | null;
}

// ── Lane Events ──

export type LaneEventActor = 'user' | 'orchestrator' | 'system';

export interface LaneTurnContextUsage {
  inputTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
}

export interface LaneEvent {
  id: string;
  laneId: string;
  verb: LaneEventVerb;
  actor: LaneEventActor;
  payload: Record<string, unknown>;
  timestamp: string;
}

// ── Lane Commands ──

export type LaneCommand =
  | {
      verb: 'open_lane';
      repoPath: string;
      projectId?: string | null;
      branch: string;
      baseBranch?: string;
      runtime: LaneRuntime;
      label?: string;
      packetId?: string;
      ownership?: LaneOwnership;
      actor?: LaneEventActor;
    }
  | {
      verb: 'bind_worktree';
      laneId: string;
      worktreePath: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'launch_session';
      laneId: string;
      prompt: string;
      model?: string;
      claudeCodeModel?: string;
      claudeCodeCarrier?: ClaudeCodeModelSource;
      spendCap?: PacketSpendCap;
      effort?: ThinkingEffort;
      /** Stable for one packet launch attempt so a crash can reconcile the owned session. */
      clientMutationId?: string;
      storageAdmissionReservationId?: string;
      launchContext?: WorkerLaunchContext;
      actor?: LaneEventActor;
    }
  | {
      verb: 'attach_session';
      laneId: string;
      sessionKey: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'send_turn';
      laneId: string;
      message: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'interrupt';
      laneId: string;
      actor?: LaneEventActor;
    }
  | {
      // Operator hard-stop: interrupt the live session AND mark the packet
      // operator-stopped so the scheduler can never auto-redispatch it. Cleared
      // by reset_packet / explicit relaunch. (2026-06-22)
      verb: 'stop';
      laneId: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'resume';
      laneId: string;
      message?: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'request_review';
      laneId: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'create_pr';
      laneId: string;
      commitMessage?: string;
      /** Orchestrator review verdict — shown on the approval card */
      reviewSummary?: string;
      /** Exact spoken-review diff fingerprint expected at action time */
      expectedDiffFingerprint?: string;
      /** Receipt-bound governance fingerprint expected at action time */
      expectedGovernanceFingerprint?: string;
      /** Approval whose exact governed continuation was spoken */
      spokenReviewApprovalId?: string;
      /** Exact CAS claim that owns this spoken approval resolution */
      spokenReviewClaimId?: string;
      /** Approval version and lane state that were spoken before resolution */
      spokenReviewUpdatedAt?: number;
      spokenReviewLaneStatus?: LaneStatus;
      actor?: LaneEventActor;
    }
  | {
      verb: 'merge';
      laneId: string;
      commitMessage?: string;
      /** Orchestrator review verdict — shown on the approval card */
      reviewSummary?: string;
      /** Set true when the orchestrator has already reviewed and approved the packet */
      orchestratorReviewed?: boolean;
      /** Conflict resolution strategy from operator approval */
      strategy?: 'ours' | 'theirs' | 'manual';
      /** Reviewed worktree HEAD expected by the operator at merge time */
      expectedHeadSha?: string;
      /** Canonical mission repository; packet clones must never publish into themselves. */
      canonicalRepoPath?: string;
      /** Exact spoken-review diff fingerprint expected at merge time */
      expectedDiffFingerprint?: string;
      /** Receipt-bound governance fingerprint expected at merge time */
      expectedGovernanceFingerprint?: string;
      /** Approval whose exact governed continuation was spoken */
      spokenReviewApprovalId?: string;
      /** Exact CAS claim that owns this spoken approval resolution */
      spokenReviewClaimId?: string;
      /** Approval version and lane state that were spoken before resolution */
      spokenReviewUpdatedAt?: number;
      spokenReviewLaneStatus?: LaneStatus;
      /** An authenticated dispatcher explicitly invoked approve_and_merge.
       * Satisfies only the surface dispatcher-review policy; merge gates and
       * all other approval postures remain authoritative. */
      surfaceDispatcherApproved?: boolean;
      actor?: LaneEventActor;
    }
  | {
      verb: 'complete';
      laneId: string;
      actor?: LaneEventActor;
    }
  | {
      verb: 'archive';
      laneId: string;
      outcome?: LaneOutcome;
      outcomeNote?: string | null;
      actor?: LaneEventActor;
    };

export type LaneVerb = LaneCommand['verb'];
export type LaneEventVerb =
  | LaneVerb
  | 'status_change'
  | 'update'
  | 'session_lost'
  | 'detach_session'
  | 'auto_archive'
  | 'merge_cleanup'
  | 'agent_report'
  | 'zombie_reap'
  | 'merge_head_drift'
  | 'review_invalidated'
  | 'runtime_drift'
  | 'pr_merged_reconciled'
  | 'merged_by_ancestry_reconciled'
  // Post-rebase typecheck escalation (#1108):
  // typecheck_auto_retry — layer 1 fired a programmatic rerun_with_feedback
  // typecheck_escalation — layer 2 promoted the lane to awaiting_orchestrator
  | 'typecheck_auto_retry'
  | 'typecheck_escalation'
  // A repo publication action exhausted its bounded resource-lease wait.
  // Payload: { resource, waitedMs, holder, retryCount, willRetry }
  | 'lease_wait_timeout'
  // Worker consulted the Engineering Brain via `o8 ask` (2026-06-11).
  // Payload: { question, class, cacheHit, sourcesConsidered, citedCount, topTitles }
  | 'brain_consulted'
  // Reserved Broadcast event kind for future agent-to-agent communication.
  // No producer exists yet; this keeps the ledger schema forward-compatible.
  | 'message'
  // Pre-launch refresh of an already-bound worktree onto current origin/base
  // (#1522 — queued dispatch:false missions must not launch on a create-time
  // base snapshot). Payload: { packetId, baseBranch, note }
  | 'worktree_refreshed'
  | 'worktree_refresh_failed'
  // Discard could not prove its preserved branch exists. Payload:
  // { code, reason, packetId, branch, ref, note, gcRisk }
  | 'branch_preservation_failed'
  // Packet dispatch refused to launch without a managed worktree.
  // Payload: { code, runtime, packetId, laneId, repoPath, cause, note }
  | 'worktree_provision_failed'
  // An owned runtime child exited. Payload includes exit code/signal, stderr,
  // and whether the runtime emitted its protocol-level result event.
  | 'runtime_process_exit'
  // An opted-in macOS worker sandbox blocked a concrete resource. Payload:
  // { runtime, surfaceId, runId, operation, resource, denialLine, message }
  | 'sandbox_denied'
  // A subscription-backed model surface crossed houses at the same policy
  // tier after quota exhaustion. These events are operator-visible audit rows.
  | 'review_fallback'
  | 'review_turn_started'
  | 'review_turn_finished'
  | 'worker_quota_exhausted'
  | 'worker_fallback'
  | 'worker_fallback_terminal'
  | 'spend_cap_hit'
  // Orchestrator review verdict, append-only (#1476 lie 3). Lane events are
  // never rescored or evicted, so review-state can always recover the verdict
  // even after mission-state resets or approval-context drift.
  // Payload: { approved, summary, reviewedHeadSha, auditApprovalId }
  | 'review_recorded'
  // Agent drove o8's embedded browser via `o8 browser` / o8_browser_* (#1232 phase 1).
  // Payload: { verb, selector?, surface?, ok, url? }
  | 'browser_acted'
  // Operator picked a best-of-N comparison winner (item 3). Recorded on the
  // winner's lane. Payload: { groupId, winnerPacketId, archivedPacketIds }
  | 'comparison_resolved'
  // Review card invalidated because the worker resumed activity after review.
  // Payload: { reason, source, surfaceId, packetId, worktreePath }
  | 'review_invalidated'
  // Review pin carried across a rebase because patch-id proved identical content.
  // Payload: { from, to, patchId, packetId }
  | 'review_carried_across_rebase'
  // Session rules governed this packet at dispatch (#1329). Snapshot of the
  // exact operator session rules injected into the worker prompt, so review is
  // "what changed, under which constraints." Payload: { threadId, ruleCount, rules }
  | 'rules_applied'
  // Packet steer injected into an existing warm session. Payload: { packetId, source, message }
  | 'steered_packet'
  // Packet steer failed before a worker turn could start. Payload: { packetId, source, message, note, stderrHead? }
  | 'steer_failed'
  // Operator stop could not kill the live worker. Payload: { packetId?, sessionKey, note, pid?, tmuxSession?, steps }
  | 'interrupt_failed'
  // Silent-exit detector found that the lane worktree HEAD is already an
  // ancestor of the refreshed base. Payload: { headSha, comparisonRef }
  | 'silent_exit_already_merged'
  // Reaper wedge-timeout enforcement (Rock 1 item 2): a parked lane sat past
  // its conservative timeout so the reaper escalated it — the invariant is
  // "nothing parks silently". Payload:
  // { from, to, elapsedMs, thresholdMs, blockedReason, action }
  | 'wedge_timeout'
  // Prune gate (Rock 1 item 3): a worktree/clone deletion was refused because
  // the tree had uncommitted work / recent activity / a non-terminal lane.
  // Payload: { worktreePath, reason, forced:false }
  | 'prune_refused'
  // Prune gate: an operator/recovery override deleted a tree the gate would
  // otherwise have refused. Payload: { worktreePath, reason, forced:true }
  | 'prune_forced'
  // Confirmed-kill escalation (Rock 1, #1471 S1): one event per ladder stage.
  // Payload: { stage, pid, confirmed }
  | 'kill_escalated'
  // Session-binding fault detector (Rock 1, #1502): an active lane reported
  // progress/heartbeat with no sessionKey bound. Payload: { packetId, source }
  | 'no_session_binding';

export type AgentReportReason =
  | 'needs_clarification'
  | 'missing_context'
  | 'out_of_scope'
  | 'dependency_blocked'
  | 'context_full'
  | 'nondeterministic_test'
  | 'external_api_down'
  | 'unknown';

// ── Lane Policy ──

export interface LanePolicy {
  branchWritable: boolean;
  requiresApproval: boolean;
  autoSpawnAllowed: boolean;
}

// ── Command Result ──

export interface LaneCommandResult {
  ok: boolean;
  laneId: string;
  note: string;
  lane?: Lane;
  /** Dependency setup path selected while provisioning this lane's worktree. */
  dependencyMaterializationMode?: 'native' | 'image' | null;
  /** Set when the command requires human approval before proceeding */
  approvalId?: string;
  /** Merge-specific — true only when `git push origin <baseBranch>` also succeeded */
  pushedToOrigin?: boolean;
  /** Merge-specific — main checkout HEAD after a successful fast-forward */
  mergeSha?: string;
  /** Merge-specific — captured when the push failed so the caller can surface it */
  pushError?: string;
  /** Merge-specific — expected worktree HEAD when optimistic locking rejects drift */
  expectedHeadSha?: string;
  /** Merge-specific — reviewed worktree HEAD when review integrity rejects drift */
  reviewedHeadSha?: string;
  /** Merge-specific — actual worktree HEAD when optimistic locking rejects drift */
  currentHeadSha?: string;
  /** Merge-specific structured refusal reason */
  reason?: string;
}

// ── Persisted State ──

export interface LaneStoreState {
  version: 1;
  lanes: Record<string, Lane>;
  events: LaneEvent[];
  updatedAt: string;
}
