import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type { MergeCheckResult } from '@/lib/lane/preview-merge';
import type { OrchestratorRuntime, PacketDispatcherAttribution, WorkerIntent, WorkerProvider } from '@/lib/orchestrator/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

export interface LoadedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  /**
   * Optional per-issue worker runtime — lets one mission mix Codex + Gemini
   * packets (the swarm "split coding/thinking" path). Falls back to the
   * mission-level `runtime` when unset; routing still validates dispatchability.
   */
  runtime?: OrchestratorRuntime;
}

export type ExistingBranchPolicy = 'auto' | 'reset' | 'continue' | 'error';

export interface CreateMissionInput {
  issues: LoadedIssue[];
  repoPath: string;
  runtime: OrchestratorRuntime;
  workerIntent?: WorkerIntent;
  requestedProvider?: WorkerProvider | null;
  requestedRuntime?: OrchestratorRuntime | null;
  requestedModel?: string | null;
  /** Requested worker reasoning effort. Applied at launch only for runtimes with
   *  a reasoning-effort surface (codex/claude-code); a no-op elsewhere. Omit for
   *  today's behavior (runtime default). */
  requestedEffort?: ThinkingEffort | null;
  constraints: string;
  /** When true, packets are chained sequentially (P2 after P1, etc.). Default: false (parallel). */
  sequential?: boolean;
  /** How create_mission handles an existing issue/inline dispatch branch. Default: auto. */
  existingBranchPolicy?: ExistingBranchPolicy;
  /**
   * Per-mission Engineering Brain override (2026-06-11) — stamps every packet's
   * `useBrain`. Omit to inherit the operator `workersUseBrain` setting.
   */
  useBrain?: boolean;
  /**
   * Originating orchestrator thread id (#1329). When set, every packet in the
   * mission inherits the thread's active session rules (via `buildPacketPrompt`)
   * and dispatch stamps a `rules_applied` lane event. Omit for thread-less
   * dispatches (no session-rule inheritance).
   */
  orchestratorThreadId?: string | null;
  /** Durable origin for routing review-worthy terminal work back to its caller. */
  dispatcher?: PacketDispatcherAttribution | null;
  /**
   * Huddle mode (#1282) — stamps every packet's `huddle`. When true, each
   * worker aligns with the orchestrator (posts plan + pushback, then STOPS)
   * before editing. Armed per-mission; omit (default off) for clear packets.
   */
  huddle?: boolean;
  /**
   * Best-of-N (Orca-teardown item 3) — stamps the seed packet's
   * `comparisonModels` so the scheduler fans it into N sibling candidates (one
   * per model string), each in its own worktree/lane. The operator then compares
   * the N diffs side-by-side and merges the winner through the review gate.
   * Same model repeated (e.g. `['codex','codex','codex']`) races N attempts of
   * the one runtime. Clamped to ≤4 at the route. Omit for a normal single packet.
   */
  comparisonModels?: string[];
}

export interface DispatchMissionInput {
  missionId?: string;
}

export interface MissionStatusInput {
  missionId?: string;
  includeCost: boolean;
}

export interface SubmitReviewInput {
  packetId: string;
  findings: OrchestratorReviewFinding[];
  approved: boolean;
  reviewedHeadSha?: string;
  /** #732 — Directives the review verified were respected by the diff. */
  directivesApplied?: string[];
  /** #732 — Directives the review found contradicted by the diff. */
  directivesViolated?: Array<{
    directive: string;
    file?: string;
    line?: number | null;
    snippet?: string;
  }>;
}

export interface ApproveAndMergeInput {
  packetId: string;
  commitMessage?: string;
  expectedHeadSha?: string;
  /** 'user' when the call carries a live human-operator principal (the
   *  desktop Approve & merge click, the operator CLI). The operator's
   *  explicit action IS the approval — one click merges, no second inbox
   *  card (Q ruling 2026-07-18, Codex merge parity). Orchestrator/worker
   *  callers omit it and keep the full approval gate. */
  actor?: 'user' | 'orchestrator';
}

export interface PickComparisonWinnerInput {
  packetId: string;
  commitMessage?: string;
}

export interface ResetPacketInput {
  packetId: string;
  reason?: string;
  clearWorktree?: boolean;
  /**
   * Generation scope for BACKGROUNDED cleanup (#1528 stop path). When set,
   * the reset only touches the lanes captured when the stop was issued —
   * never lanes bound afterwards — skips the prefix-glob orphan worktree
   * sweep (which would rm -rf a re-dispatched packet's LIVE worktree), and
   * only applies the mission-state hold if the packet is still in the
   * operator-stopped state this cleanup belongs to. Without it a stop's
   * background reset could silently revert and destroy a legitimate
   * re-dispatch that happened during the cleanup window.
   */
  scope?: {
    laneIds: string[];
    skipHoldIfStateMoved?: boolean;
  };
}

export interface MergePacketResult {
  merged: boolean;
  note: string;
  /** True when the requested packet had already reached a released/closed state before this call. */
  alreadyReleased?: boolean;
  /** Verified merge commit for already-released or newly merged packets. */
  mergeSha?: string;
  /** True when `mergeSha` was checked as an ancestor of the main checkout HEAD. */
  ancestryVerified?: boolean;
  approvalId?: string;
  /**
   * Structured gate verdict (#623). Populated when the merge path ran the
   * gate — preview calls, pre-dispatch gate failures, and post-dispatch
   * approvals. Omitted when the failure came from a non-gate source
   * (e.g. policy approval, orphan lane error).
   */
  checks?: MergeCheckResult[];
  /** Short category labels for every blocking gate violation. */
  blockers?: string[];
  /**
   * Back-compat derived from `blockers.join(', ')` so older UI clients
   * that read a `reason` field still render something sane. New callers
   * should prefer `blockers` / `checks`.
   */
  reason?: string;
  /** Expected worktree HEAD when optimistic locking rejects drift. */
  expectedHeadSha?: string;
  /** Reviewed worktree HEAD when review integrity rejects drift. */
  reviewedHeadSha?: string;
  /** Actual worktree HEAD when optimistic locking rejects drift. */
  currentHeadSha?: string;
}
