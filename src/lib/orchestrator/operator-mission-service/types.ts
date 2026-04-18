import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

export interface LoadedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface CreateMissionInput {
  issues: LoadedIssue[];
  repoPath: string;
  runtime: OrchestratorRuntime;
  constraints: string;
  /** When true, packets are chained sequentially (P2 after P1, etc.). Default: false (parallel). */
  sequential?: boolean;
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
  approvalId?: string;
}
