import type { automations } from '@/lib/db/schema';
import { getAutomationFireMetrics, listAutomationFires } from './fire-store';

export function automationApiRecord(row: typeof automations.$inferSelect) {
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
