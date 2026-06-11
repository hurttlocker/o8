import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type { MergeCheckResult } from '@/lib/lane/preview-merge';
import type { OrchestratorRuntime, WorkerIntent, WorkerProvider } from '@/lib/orchestrator/types';

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
}

export interface PickComparisonWinnerInput {
  packetId: string;
  commitMessage?: string;
}

export interface ResetPacketInput {
  packetId: string;
  reason?: string;
  clearWorktree?: boolean;
}

export interface MergePacketResult {
  merged: boolean;
  note: string;
  /** True when the requested packet had already reached a released/closed state before this call. */
  alreadyReleased?: boolean;
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
  /** Actual worktree HEAD when optimistic locking rejects drift. */
  currentHeadSha?: string;
}
