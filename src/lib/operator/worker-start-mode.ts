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
  { value: 'autonomous', long: 'Code', short: 'Code', detail: 'Starts the worker immediately in its worktree.' },
  { value: 'huddle', long: 'Plan', short: 'Plan', detail: 'The worker reads the task, shares a plan with the lead, then waits before editing.' },
  { value: 'adaptive', long: 'Auto', short: 'Auto', detail: 'Uses Plan when the active worker profile requires it; otherwise starts work immediately.' },
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
