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
  | 'recovering'      // agent/session died; operator can retry the packet
  | 'reviewing'       // work done, review needed
  | 'merging'         // merge in progress
  | 'failed'          // terminal failure, operator must redispatch or archive
  | 'completed'       // done and merged
  | 'archived';       // no longer active

/**
 * Managed = IDE spawned it, full control (steer, interrupt, review).
 * Attached = discovered existing session, inspect + capability-gated.
 */
export type LaneOwnership = 'managed' | 'attached';

// LaneRuntime intentionally mirrors OrchestratorRuntime so packets with any
// runtime can be routed through the lane system. The lane command bus
// dispatches to the correct CLI adapter at launch time.
export type LaneRuntime = 'codex' | 'claude-code' | 'gemini' | 'opencode';

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
  status: LaneStatus;
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
  | 'runtime_drift'
  // Post-rebase typecheck escalation (#1108):
  // typecheck_auto_retry — layer 1 fired a programmatic rerun_with_feedback
  // typecheck_escalation — layer 2 promoted the lane to awaiting_orchestrator
  | 'typecheck_auto_retry'
  | 'typecheck_escalation'
  // Worker consulted the Engineering Brain via `o8 ask` (2026-06-11).
  // Payload: { question, class, cacheHit, sourcesConsidered, citedCount, topTitles }
  | 'brain_consulted'
  // Agent drove o8's embedded browser via `o8 browser` / o8_browser_* (#1232 phase 1).
  // Payload: { verb, selector?, surface?, ok, url? }
  | 'browser_acted';

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
  /** Set when the command requires human approval before proceeding */
  approvalId?: string;
  /** Merge-specific — true only when `git push origin <baseBranch>` also succeeded */
  pushedToOrigin?: boolean;
  /** Merge-specific — captured when the push failed so the caller can surface it */
  pushError?: string;
  /** Merge-specific — expected worktree HEAD when optimistic locking rejects drift */
  expectedHeadSha?: string;
  /** Merge-specific — actual worktree HEAD when optimistic locking rejects drift */
  currentHeadSha?: string;
}

// ── Persisted State ──

export interface LaneStoreState {
  version: 1;
  lanes: Record<string, Lane>;
  events: LaneEvent[];
  updatedAt: string;
}
