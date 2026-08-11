import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

import { isSingleSubCheapTierWorker, type SubscriptionProfile } from './subscription-profile';

export type WorkerStartMode = 'autonomous' | 'huddle' | 'adaptive';

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
