import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type { MergeCheckResult } from '@/lib/lane/preview-merge';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

export interface LoadedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

export type ExistingBranchPolicy = 'auto' | 'reset' | 'continue' | 'error';

export interface CreateMissionInput {
  issues: LoadedIssue[];
  repoPath: string;
  runtime: OrchestratorRuntime;
  constraints: string;
  /** When true, packets are chained sequentially (P2 after P1, etc.). Default: false (parallel). */
  sequential?: boolean;
  /** How create_mission handles an existing issue/inline dispatch branch. Default: auto. */
  existingBranchPolicy?: ExistingBranchPolicy;
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
}

export interface ApproveAndMergeInput {
  packetId: string;
  commitMessage?: string;
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
}
