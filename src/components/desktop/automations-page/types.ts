export type TriggerKind = 'manual' | 'cron' | 'watch';
export type RunStatus = 'idle' | 'running' | 'ok' | 'error';
export type AutomationScope = 'mine' | 'team';
export type CatchUpPolicy = 'latest' | 'all' | 'skip';
export type AutomationFireStatus = 'pending' | 'leased' | 'retrying' | 'recovered' | 'succeeded' | 'skipped_precheck' | 'precheck_error' | 'parked' | 'cancelled';

export interface AutomationFireRecord {
  id: string;
  source: 'scheduled' | 'manual' | 'watch';
  status: AutomationFireStatus;
  scheduledAt: number;
  claimedAt: number | null;
  completedAt: number | null;
  claimCount: number;
  attemptCount: number;
  maxAttempts: number;
  recoveryCount: number;
  laneId: string | null;
  missionId: string | null;
  resultNote: string | null;
  scheduleDelayMs: number | null;
  queueDelayMs: number | null;
  executionMs: number | null;
  concurrentCount: number | null;
  duplicateCount: number;
  precheckCommand: string | null;
  precheckTimeoutMs: number | null;
  precheckBypassed: boolean;
  precheckStatus: 'none' | 'pending' | 'running' | 'passed' | 'skipped' | 'error' | 'bypassed';
  precheckDurationMs: number | null;
  precheckExitCode: number | null;
  precheckStdoutTail: string | null;
  precheckStderrTail: string | null;
  precheckErrorMessage: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  sourceEventType: string | null;
  sourcePayload: Record<string, unknown> | null;
  actionKind: 'dispatch' | 'notify' | 'steer' | 'approval';
  targetLaneId: string | null;
}

export interface AutomationFireMetrics {
  count: number;
  scheduleDelayMs: { p50: number | null; p95: number | null };
  queueDelayMs: { p50: number | null; p95: number | null };
  executionMs: { p50: number | null; p95: number | null };
  maxConcurrentFires: number;
  duplicateFireCount: number;
}

export interface AutomationRecord {
  id: string;
  name: string;
  owner: string;
  projectId: string | null;
  repoPath: string;
  branch: string;
  runtime: string;
  prompt: string;
  triggerKind: TriggerKind;
  cronExpr: string | null;
  enabled: boolean;
  nextRunAt: number | null;
  catchUpPolicy: CatchUpPolicy;
  repoConcurrencyLimit: number;
  precheckCommand: string | null;
  precheckTimeoutMs: number;
  watchSourceKind: 'managed_run' | 'packet' | 'repository' | null;
  watchSourceId: string | null;
  watchEventTypes: string[];
  watchLiteralFilter: string | null;
  watchQuietMs: number | null;
  watchMinIntervalMs: number;
  watchBatchWindowMs: number;
  watchMaxFiresPerTick: number;
  watchExpiresAt: number | null;
  watchActionKind: 'dispatch' | 'notify' | 'steer' | 'approval';
  watchTargetLaneId: string | null;
  watchCheckpoint: number;
  watchLastFireAt: number | null;
  watchState: 'watching' | 'paused' | 'expired' | null;
  lastRunAt: number | null;
  lastRunStatus: RunStatus;
  lastLaneId: string | null;
  lastErrorMessage: string | null;
  fires: AutomationFireRecord[];
  fireMetrics: AutomationFireMetrics;
  createdAt: string;
  updatedAt: string;
}

export interface RegisteredRepo {
  id: string;
  name: string;
  localPath: string;
  defaultBranch: string;
}

export interface AutomationFormState {
  name: string;
  prompt: string;
  runtime: string;
  repoPath: string;
  branch: string;
  triggerKind: TriggerKind;
  cronExpr: string;
  catchUpPolicy: CatchUpPolicy;
  repoConcurrencyLimit: number;
  precheckCommand: string;
  precheckTimeoutMs: number;
  watchSourceKind: 'managed_run' | 'packet' | 'repository';
  watchSourceId: string;
  watchEventTypes: string;
  watchLiteralFilter: string;
  watchQuietMs: number;
  watchMinIntervalMs: number;
  watchBatchWindowMs: number;
  watchMaxFiresPerTick: number;
  watchActionKind: 'dispatch' | 'notify' | 'steer' | 'approval';
  watchTargetLaneId: string;
}
