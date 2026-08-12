import type { LaneStatus } from '@/lib/lane/types';

export const MISSION_FUNNEL_SCHEMA_VERSION = 1 as const;
type FunnelTimestamp = string | null;

export interface MissionFunnelPhases {
  createdAt: FunnelTimestamp;
  enqueuedAt: FunnelTimestamp;
  claimedAt: FunnelTimestamp;
  launchStartedAt: FunnelTimestamp;
  workerReadyAt: FunnelTimestamp;
  firstOutputAt: FunnelTimestamp;
  lastOutputAt: FunnelTimestamp;
  reviewReadyAt: FunnelTimestamp;
  approvalRequestedAt: FunnelTimestamp;
  approvedAt: FunnelTimestamp;
  mergedAt: FunnelTimestamp;
  terminalAt: FunnelTimestamp;
}

export interface MissionFunnelDurations {
  queueMs: number | null;
  claimToLaunchMs: number | null;
  startupMs: number | null;
  firstOutputMs: number | null;
  executionMs: number | null;
  reviewMs: number | null;
  approvalMs: number | null;
  mergeMs: number | null;
  totalMs: number | null;
  idleMs: number;
  operatorWaitMs: number;
  recoveryMs: number;
}

export type MissionFunnelTerminalDisposition =
  | 'merged' | 'closed' | 'failed' | 'cancelled' | 'partial' | 'in_progress' | 'unknown';

export type MissionFunnelInterventionKind =
  | 'steer' | 'rerun_with_feedback' | 'reset' | 'manual_code_change'
  | 'rejection' | 'stop' | 'archive' | 'manual_merge_rescue';

export interface MissionFunnelAction {
  kind: MissionFunnelInterventionKind;
  at: string;
  laneId: string | null;
  source: string;
}

export interface MissionFunnelRecoveryEvent { kind: string; at: string; laneId: string }

export interface MissionFunnelAttempt {
  attempt: number;
  laneId: string;
  runtime: string;
  sessionKey: string | null;
  identityId: string | null;
  launchKind: 'cold' | 'warm' | 'adopted' | 'unknown';
  phases: Omit<MissionFunnelPhases, 'createdAt' | 'enqueuedAt' | 'approvalRequestedAt' | 'approvedAt'>;
  durations: Pick<MissionFunnelDurations,
    'claimToLaunchMs' | 'startupMs' | 'firstOutputMs' | 'executionMs' | 'idleMs' | 'operatorWaitMs' | 'recoveryMs'>;
  terminalStatus: LaneStatus | null;
}

export interface MissionFunnelPacketReceipt {
  packetId: string;
  title: string;
  repoLabel: string | null;
  repoPath: string | null;
  runtime: string;
  model: string | null;
  identityId: string | null;
  phases: MissionFunnelPhases;
  durations: MissionFunnelDurations;
  attempts: MissionFunnelAttempt[];
  attemptCount: number;
  retryCount: number;
  interventions: MissionFunnelAction[];
  recoveryEvents: MissionFunnelRecoveryEvent[];
  terminalDisposition: MissionFunnelTerminalDisposition;
  strictAutonomousClose: boolean | null;
  governedAutonomousClose: boolean | null;
  missingSignals: string[];
}

export interface MissionFunnelPercentiles {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export interface MissionFunnelReceipt {
  schemaVersion: typeof MISSION_FUNNEL_SCHEMA_VERSION;
  missionId: string;
  createdAt: FunnelTimestamp;
  terminalAt: FunnelTimestamp;
  totalDurationMs: number | null;
  packets: MissionFunnelPacketReceipt[];
  terminalPacketCount: number;
  successfulPacketCount: number;
  failedPacketCount: number;
  interventionPacketCount: number;
  attemptCount: number;
  retryCount: number;
  interventionCount: number;
  recoveryEventCount: number;
  strictAutonomousCloseCount: number;
  governedAutonomousCloseCount: number;
  autonomyObservedPacketCount: number;
  strictAutonomousCloseRate: number | null;
  governedAutonomousCloseRate: number | null;
  failureRate: number | null;
  interventionRate: number | null;
  throughputPerHour: number | null;
  phasePercentiles: Record<keyof Pick<MissionFunnelDurations,
    'queueMs' | 'startupMs' | 'firstOutputMs' | 'executionMs' | 'reviewMs' | 'approvalMs' | 'totalMs'>,
    MissionFunnelPercentiles>;
  missingSignals: string[];
}
