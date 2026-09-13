import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

import { isSingleSubCheapTierWorker, type SubscriptionProfile } from './subscription-profile';

export type WorkerStartMode = 'autonomous' | 'huddle' | 'adaptive';

export interface WorkerStartOption {
  value: WorkerStartMode;
  long: string;
  short: string;
  detail: string;
}

export const WORKER_START_OPTIONS: ReadonlyArray<WorkerStartOption> = [
  { value: 'autonomous', long: 'Run now', short: 'Run', detail: 'The worker implements immediately inside its worktree.' },
  { value: 'huddle', long: 'Plan first', short: 'Plan', detail: 'The worker reads the task, shares a plan with the lead, and waits before editing.' },
  { value: 'adaptive', long: 'Adaptive', short: 'Adaptive', detail: 'Lower-cost subscription workers plan first; other workers run immediately.' },
];

export function isWorkerStartMode(value: unknown): value is WorkerStartMode {
  return value === 'autonomous' || value === 'huddle' || value === 'adaptive';
}

export function resolveWorkerHuddle(input: {
  mode?: WorkerStartMode;
  explicitHuddle?: boolean;
  profile: SubscriptionProfile;
  runtime: OrchestratorRuntime;
  model: string | null;
}): boolean {
  if (typeof input.explicitHuddle === 'boolean') return input.explicitHuddle;
  if (input.mode === 'huddle') return true;
  if (input.mode !== 'adaptive') return false;
  return isSingleSubCheapTierWorker({
    profile: input.profile,
    runtime: input.runtime,
    model: input.model,
  });
}
