import type { ExistingBranchPolicy } from '@/lib/orchestrator/operator-mission-service';
import type { WorkerIntent } from '@/lib/orchestrator/types';

export function parseExistingBranchPolicy(value: unknown): ExistingBranchPolicy | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'auto' || value === 'reset' || value === 'continue' || value === 'error') {
    return value;
  }
  throw new Error('existingBranchPolicy must be one of: auto, reset, continue, error.');
}

export function parseWorkerIntent(value: unknown): WorkerIntent | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    value === 'light_worker'
    || value === 'heavy_worker'
    || value === 'reviewer'
    || value === 'diagnostic'
    || value === 'orchestrator'
  ) {
    return value;
  }
  throw new Error('workerIntent must be one of: light_worker, heavy_worker, reviewer, diagnostic, orchestrator.');
}
