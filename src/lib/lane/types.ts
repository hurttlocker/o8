/**
 * Lane Domain Model
 *
 * A lane is the durable operator-facing unit in Cortex IDE.
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
  | 'reviewing'       // work done, review needed
  | 'merging'         // merge in progress
  | 'completed'       // done and merged
  | 'archived';       // no longer active

/**
 * Managed = IDE spawned it, full control (steer, interrupt, review).
 * Attached = discovered existing session, inspect + capability-gated.
 */
export type LaneOwnership = 'managed' | 'attached';

export type LaneRuntime = 'codex' | 'claude-code';

// ── Lane ──

export interface Lane {
  id: string;
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
  verb: string;
  actor: LaneEventActor;
  payload: Record<string, unknown>;
  timestamp: string;
}

// ── Lane Commands ──

export type LaneCommand =
  | {
      verb: 'open_lane';
      repoPath: string;
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
}

// ── Persisted State ──

export interface LaneStoreState {
  version: 1;
  lanes: Record<string, Lane>;
  events: LaneEvent[];
  updatedAt: string;
}
