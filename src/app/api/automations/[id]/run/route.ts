/**
 * POST /api/automations/[id]/run — fire an automation now.
 *
 * Updates lastRunAt + lastRunStatus on the row. For cron rows, also recomputes
 * nextRunAt off the current time so an early manual fire pushes the next
 * scheduled fire forward (matches typical cron semantics).
 *
 * Loopback-gated via middleware.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { runAutomation } from '@/lib/automations/runner';
import { computeNextRunAt } from '@/lib/automations/cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'db unavailable' }, { status: 500 });
  const row = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!row.enabled) return NextResponse.json({ error: 'automation is disabled' }, { status: 409 });

  // Mark as running before dispatch so the UI reflects state immediately.
  const startedAt = Date.now();
  db.update(automations).set({
    lastRunAt: startedAt,
    lastRunStatus: 'running',
  }).where(eq(automations.id, id)).run();

  const result = await runAutomation(row);

  const finalStatus = result.ok ? 'ok' : 'error';
  // Recompute next-fire timestamp off this run for cron rows.
  const nextRunAt = row.triggerKind === 'cron' && row.cronExpr
    ? computeNextRunAt(row.cronExpr, startedAt)
    : null;

  db.update(automations).set({
    lastRunStatus: finalStatus,
    lastLaneId: result.laneId ?? row.lastLaneId,
    nextRunAt,
    // Persist the note when it errored so the UI can surface a tooltip;
    // clear it on a clean run so a one-off failure doesn't haunt the row.
    lastErrorMessage: result.ok ? null : (result.note ?? 'run failed'),
  }).where(eq(automations.id, id)).run();

  if (!result.ok) {
    return NextResponse.json({ ok: false, laneId: result.laneId ?? null, note: result.note ?? 'run failed' }, { status: 502 });
  }
  return NextResponse.json({ ok: true, laneId: result.laneId, note: result.note });
}
