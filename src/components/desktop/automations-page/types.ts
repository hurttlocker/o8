export type TriggerKind = 'manual' | 'cron';
export type RunStatus = 'idle' | 'running' | 'ok' | 'error';
export type AutomationScope = 'mine' | 'team';
export type CatchUpPolicy = 'latest' | 'all' | 'skip';
export type AutomationFireStatus = 'pending' | 'leased' | 'retrying' | 'recovered' | 'succeeded' | 'parked' | 'cancelled';

export interface AutomationFireRecord {
  id: string;
  source: 'scheduled' | 'manual';
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
}
