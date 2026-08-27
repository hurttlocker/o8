import type { automations } from '@/lib/db/schema';
import { getAutomationFireMetrics, listAutomationFires } from './fire-store';

export function automationApiRecord(row: typeof automations.$inferSelect) {
  let watchEventTypes: string[] = [];
  try {
    const parsed = JSON.parse(row.watchEventTypesJson) as unknown;
    if (Array.isArray(parsed)) watchEventTypes = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    watchEventTypes = [];
  }
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    projectId: row.projectId,
    repoPath: row.repoPath,
    branch: row.branch,
    runtime: row.runtime,
    prompt: row.prompt,
    triggerKind: row.triggerKind,
    cronExpr: row.cronExpr,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    catchUpPolicy: row.catchUpPolicy,
    repoConcurrencyLimit: row.repoConcurrencyLimit,
    precheckCommand: row.precheckCommand,
    precheckTimeoutMs: row.precheckTimeoutMs,
    watchSourceKind: row.watchSourceKind,
    watchSourceId: row.watchSourceId,
    watchEventTypes,
    watchLiteralFilter: row.watchLiteralFilter,
    watchQuietMs: row.watchQuietMs,
    watchMinIntervalMs: row.watchMinIntervalMs,
    watchBatchWindowMs: row.watchBatchWindowMs,
    watchMaxFiresPerTick: row.watchMaxFiresPerTick,
    watchExpiresAt: row.watchExpiresAt,
    watchActionKind: row.watchActionKind,
    watchTargetLaneId: row.watchTargetLaneId,
    watchCheckpoint: row.watchCheckpoint,
    watchLastFireAt: row.watchLastFireAt,
    watchState: row.triggerKind !== 'watch'
      ? null
      : row.watchExpiresAt != null && row.watchExpiresAt <= Date.now()
        ? 'expired'
        : row.enabled ? 'watching' : 'paused',
    lastRunAt: row.lastRunAt,
    lastRunStatus: row.lastRunStatus,
    lastLaneId: row.lastLaneId,
    lastErrorMessage: row.lastErrorMessage,
    fires: listAutomationFires(row.id, 8),
    fireMetrics: getAutomationFireMetrics(row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
