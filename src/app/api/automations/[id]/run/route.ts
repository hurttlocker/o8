/** Persist and execute one idempotent manual automation fire. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import {
  claimNextAutomationFire,
  getAutomationFire,
  persistManualAutomationFire,
} from '@/lib/automations/fire-store';
import { runClaimedAutomationFire } from '@/lib/automations/fire-runner';
import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'db unavailable' }, { status: 500 });
  const row = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!row.enabled) return NextResponse.json({ error: 'automation is disabled' }, { status: 409 });

  const body = await request.json().catch(() => null) as { clientMutationId?: unknown } | null;
  const clientMutationId = typeof body?.clientMutationId === 'string' && body.clientMutationId.trim()
    ? body.clientMutationId.trim()
    : request.headers.get('x-o8-client-mutation-id')?.trim() || randomUUID();
  const fire = persistManualAutomationFire(id, clientMutationId);
  if (!fire) return NextResponse.json({ error: 'automation is disabled or unavailable' }, { status: 409 });
  if (fire.status === 'succeeded' || fire.status === 'parked' || fire.status === 'cancelled') {
    return NextResponse.json({
      ok: fire.status === 'succeeded',
      fire,
      laneId: fire.laneId,
      note: fire.resultNote,
      replayed: true,
    }, { status: fire.status === 'succeeded' ? 200 : 502 });
  }

  const workerId = `manual:${process.env.O8_BOOT_ID?.trim() || process.pid}`;
  const claimed = claimNextAutomationFire({
    workerId,
    leaseMs: 60 * 60 * 1000,
    concurrencyCap: Math.max(1, Number.parseInt(process.env.O8_AUTOMATION_CONCURRENCY ?? '4', 10) || 4),
    fireId: fire.id,
  });
  if (!claimed) {
    return NextResponse.json({
      ok: true,
      fire: getAutomationFire(fire.id),
      queued: true,
      note: 'Automation fire is persisted and waiting for scheduler capacity.',
    }, { status: 202 });
  }
  const settled = await runClaimedAutomationFire(claimed);
  if (!settled) {
    return NextResponse.json({ ok: false, fireId: fire.id, note: 'fire settlement unavailable' }, { status: 503 });
  }
  const ok = settled.status === 'succeeded';
  return NextResponse.json({
    ok,
    fire: settled,
    laneId: settled.laneId,
    note: settled.resultNote,
  }, { status: ok ? 200 : 502 });
}
