/**
 * scheduler.ts — in-process cron tick for the automations table.
 *
 * Boots once from ws-server.ts on startup. Wakes every 30 seconds, asks the
 * DB for enabled cron rows whose `nextRunAt <= now`, fires them through the
 * shared `runAutomation` runner, and recomputes the next-fire time.
 *
 * Resolution is minute-level (cron expressions are minute-granular), so a
 * 30s tick guarantees we never miss a fire window. Each run holds the row in
 * `lastRunStatus='running'` so concurrent ticks don't double-fire — a row
 * stuck in `running` will pause future fires until the operator clears it
 * (manual rerun via the page resets the status).
 *
 * Manual triggers go through /api/automations/[id]/run instead; this loop
 * only handles cron rows.
 */

import { and, eq, lte, ne } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { runAutomation } from './runner';
import { computeNextRunAt } from './cron';

const TICK_MS = 30_000;
let started = false;

export function bootAutomationsScheduler(): void {
  if (started) return;
  started = true;
  if (process.env.O8_DISABLE_AUTOMATIONS === '1') {
    console.log('[automations-scheduler] disabled via O8_DISABLE_AUTOMATIONS=1');
    return;
  }

  console.log(`[automations-scheduler] ticking every ${TICK_MS / 1000}s`);
  // Kick off an immediate tick so a newly-started server doesn't have to wait
  // 30s for the first poll (useful for "just created an automation" flows).
  setTimeout(() => { void tickAutomations(); }, 2_000).unref();
  setInterval(() => { void tickAutomations(); }, TICK_MS).unref();
}

async function tickAutomations(): Promise<void> {
  const db = getDb();
  if (!db) return;
  const now = Date.now();

  // Pick up enabled cron rows whose next fire is due AND aren't currently in
  // flight. Drizzle's `and/eq` chain compiles to a single WHERE clause —
  // grabs both at once with the (enabled, next_run_at) index.
  const due = db
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.enabled, true),
        eq(automations.triggerKind, 'cron'),
        lte(automations.nextRunAt, now),
        ne(automations.lastRunStatus, 'running'),
      ),
    )
    .all();

  if (due.length === 0) return;

  for (const row of due) {
    if (!row.cronExpr) continue;
    // Mark running immediately so a subsequent tick (or a concurrent /run
    // hit from the page) can see the row is in flight.
    db.update(automations).set({
      lastRunAt: now,
      lastRunStatus: 'running',
    }).where(eq(automations.id, row.id)).run();

    let resultLaneId: string | undefined;
    let status: 'ok' | 'error' = 'ok';
    let note: string | undefined;
    try {
      const result = await runAutomation(row);
      resultLaneId = result.laneId;
      status = result.ok ? 'ok' : 'error';
      note = result.note;
    } catch (err) {
      status = 'error';
      note = err instanceof Error ? err.message : 'tick run failed';
    }

    const nextRunAt = computeNextRunAt(row.cronExpr, now);
    db.update(automations).set({
      lastRunStatus: status,
      lastLaneId: resultLaneId ?? row.lastLaneId,
      nextRunAt,
      lastErrorMessage: status === 'ok' ? null : (note ?? 'cron run failed'),
    }).where(eq(automations.id, row.id)).run();

    if (status === 'error') {
      console.warn(`[automations-scheduler] ${row.name} (${row.id}) errored: ${note ?? '(no note)'}`);
    } else {
      console.log(`[automations-scheduler] ${row.name} (${row.id}) → lane ${resultLaneId ?? '(no lane)'}`);
    }
  }
}
