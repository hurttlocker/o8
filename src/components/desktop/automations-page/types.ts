export type TriggerKind = 'manual' | 'cron';
export type RunStatus = 'idle' | 'running' | 'ok' | 'error';
export type AutomationScope = 'mine' | 'team';

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
  lastRunAt: number | null;
  lastRunStatus: RunStatus;
  lastLaneId: string | null;
  lastErrorMessage: string | null;
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
}
