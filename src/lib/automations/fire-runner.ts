import { eq } from 'drizzle-orm';

import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { computeNextRunAt } from './cron';
import { runAutomation } from './runner';
import { getAutomationFire, settleAutomationFire, type AutomationFire } from './fire-store';

export async function runClaimedAutomationFire(
  fire: AutomationFire,
  now: () => number = Date.now,
): Promise<AutomationFire | undefined> {
  if (fire.status !== 'leased' || !fire.claimedBy || !fire.leaseToken) return undefined;
  const db = getDb();
  if (!db) return undefined;
  const row = db.select().from(automations).where(eq(automations.id, fire.automationId)).get();
  if (!row) return getAutomationFire(fire.id);

  db.update(automations).set({
    lastRunAt: fire.claimedAt ?? now(),
    lastRunStatus: 'running',
  }).where(eq(automations.id, row.id)).run();

  let result: Awaited<ReturnType<typeof runAutomation>>;
  try {
    result = await runAutomation(row);
  } catch (error) {
    result = {
      ok: false,
      note: error instanceof Error ? error.message : 'automation runner failed',
    };
  }
  const settled = settleAutomationFire({
    fireId: fire.id,
    workerId: fire.claimedBy,
    leaseToken: fire.leaseToken,
    ok: result.ok,
    laneId: result.laneId,
    note: result.note,
    nowMs: now(),
  });
  if (!settled) return undefined;

  db.update(automations).set({
    lastRunStatus: settled.status === 'succeeded' ? 'ok' : 'error',
    lastLaneId: settled.laneId ?? row.lastLaneId,
    lastErrorMessage: settled.status === 'succeeded' ? null : settled.resultNote,
    nextRunAt: fire.source === 'manual' && row.triggerKind === 'cron' && row.cronExpr
      ? computeNextRunAt(row.cronExpr, fire.claimedAt ?? now())
      : row.nextRunAt,
  }).where(eq(automations.id, row.id)).run();
  return settled;
}
