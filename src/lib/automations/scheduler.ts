/**
 * scheduler.ts — in-process cron tick for the automations table.
 *
 * Boots once from ws-server.ts on startup. Wakes every 30 seconds, asks the
 * DB for enabled cron rows whose `nextRunAt <= now`, fires them through the
 * shared `runAutomation` runner, and recomputes the next-fire time.
 *
 * Resolution is minute-level (cron expressions are minute-granular), so a
 * 30s tick guarantees we never miss a fire window. Each run holds the row in
 * `lastRunStatus='running'` so concurrent ticks don't double-fire.
 *
 * Persistence model:
 * - DB state survives crashes (SQLite on disk).
 * - When ws-server reboots, scheduler reboots with it; overdue rows
 *   (nextRunAt < now) are picked up by the first tick. Missed fires
 *   collapse — a row whose cron should have fired 24 times during downtime
 *   fires once, then nextRunAt advances past the present.
 * - Stuck rows (running > STALE_RUN_MS) are auto-reset before each tick
 *   scans for due rows — protects against hung Codex runs that never
 *   complete and would otherwise pause future fires forever.
 * - Heartbeat at ~/.o8/automations-scheduler.heartbeat tracks the last
 *   tick time so operators can confirm the scheduler is alive.
 *
 * Manual triggers go through /api/automations/[id]/run instead; this loop
 * only handles cron rows.
 */

import { and, eq, lte } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { runAutomation } from './runner';
import { computeNextRunAt } from './cron';
import { getDataDir } from '@/lib/data-dir-migration';

const TICK_MS = 30_000;
const DEFAULT_STALE_RUN_MS = 60 * 60 * 1000; // 60 minutes
const STALE_RUN_MS = (() => {
  const raw = process.env.O8_AUTOMATION_STALE_RUN_MS;
  if (!raw) return DEFAULT_STALE_RUN_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_RUN_MS;
})();
const HEARTBEAT_PATH = path.join(
  getDataDir(),
  'automations-scheduler.heartbeat',
);
let started = false;
let bootedAt = 0;

export function bootAutomationsScheduler(): void {
  if (started) return;
  started = true;
  if (process.env.O8_DISABLE_AUTOMATIONS === '1') {
    console.log('[automations-scheduler] disabled via O8_DISABLE_AUTOMATIONS=1');
    return;
  }

  bootedAt = Date.now();
  console.log(
    `[automations-scheduler] ticking every ${TICK_MS / 1000}s · `
    + `stuck-run cutoff ${Math.round(STALE_RUN_MS / 60_000)}m · `
    + `heartbeat ${HEARTBEAT_PATH}`,
  );
  // Boot diagnostics — log overdue + stuck counts so the operator can see
  // recovery activity after a crash / restart.
  logBootCatchUp();
  // Kick off an immediate tick so a newly-started server doesn't have to wait
  // 30s for the first poll (useful for "just created an automation" flows).
  setTimeout(() => { void tickAutomations(); }, 2_000).unref();
  setInterval(() => { void tickAutomations(); }, TICK_MS).unref();
}

function logBootCatchUp(): void {
  const db = getDb();
  if (!db) return;
  const now = Date.now();
  const overdue = db
    .select({ id: automations.id, name: automations.name, nextRunAt: automations.nextRunAt })
    .from(automations)
    .where(
      and(
        eq(automations.enabled, true),
        eq(automations.triggerKind, 'cron'),
        lte(automations.nextRunAt, now),
      ),
    )
    .all();
  const stuck = db
    .select({ id: automations.id, name: automations.name, lastRunAt: automations.lastRunAt })
    .from(automations)
    .where(
      and(
        eq(automations.lastRunStatus, 'running'),
        lte(automations.lastRunAt, now - STALE_RUN_MS),
      ),
    )
    .all();
  if (overdue.length > 0) {
    console.log(`[automations-scheduler] boot: ${overdue.length} cron row(s) overdue — will fire on first tick`);
  }
  if (stuck.length > 0) {
    console.log(`[automations-scheduler] boot: ${stuck.length} row(s) stuck in 'running' — will auto-reset on first tick`);
  }
}

async function tickAutomations(): Promise<void> {
  const db = getDb();
  if (!db) return;
  const now = Date.now();

  // Heartbeat — best-effort write; never throws into the tick path.
  writeHeartbeat(now);

  // Step 1: recover stuck rows. Any row that's been in 'running' longer than
  // STALE_RUN_MS is presumed dead (hung agent, killed process, runner stuck
  // mid-dispatch). Mark as error so its cron can fire again on this same tick.
  recoverStuckRows(now);

  // Step 2: pick up enabled cron rows whose next fire is due AND aren't
  // currently in flight. Drizzle's `and/eq` chain compiles to a single WHERE
  // clause — grabs both at once with the (enabled, next_run_at) index.
  // (After recoverStuckRows above, prior `running` ghosts are now `error` so
  // the `running`-skip filter below is a safety net, not the main gate.)
  const due = db
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.enabled, true),
        eq(automations.triggerKind, 'cron'),
        lte(automations.nextRunAt, now),
      ),
    )
    .all()
    // Skip any row still in 'running' (would be rare after recover sweep
    // above, but possible if a row just transitioned within the same tick).
    .filter((row) => row.lastRunStatus !== 'running');

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

function recoverStuckRows(now: number): void {
  const db = getDb();
  if (!db) return;
  const cutoff = now - STALE_RUN_MS;
  const stuck = db
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.lastRunStatus, 'running'),
        lte(automations.lastRunAt, cutoff),
      ),
    )
    .all();
  if (stuck.length === 0) return;

  for (const row of stuck) {
    const elapsedMin = row.lastRunAt ? Math.floor((now - row.lastRunAt) / 60_000) : 0;
    const msg = `Run did not complete after ${elapsedMin}m — auto-reset by scheduler`;
    db.update(automations).set({
      lastRunStatus: 'error',
      lastErrorMessage: msg,
    }).where(eq(automations.id, row.id)).run();
    console.warn(`[automations-scheduler] auto-reset stuck row: ${row.name} (${row.id}) after ${elapsedMin}m`);
  }
}

function writeHeartbeat(now: number): void {
  try {
    writeFileSync(
      HEARTBEAT_PATH,
      JSON.stringify({
        lastTickAt: now,
        bootedAt,
        tickIntervalMs: TICK_MS,
        staleRunCutoffMs: STALE_RUN_MS,
      }) + '\n',
    );
  } catch {
    // Heartbeat is diagnostic-only; never let an FS issue break the tick.
  }
}
