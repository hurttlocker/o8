/**
 * /api/automations/[id] — update (PATCH) and delete an automation.
 *
 * PATCH  → { automation: AutomationRow }   partial update; cron change triggers nextRunAt recompute.
 * DELETE → { ok: true }
 *
 * Loopback-gated via middleware.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { computeNextRunAt, validateCron } from '@/lib/automations/cron';
import { automationApiRecord } from '@/lib/automations/api-shape';
import { cancelAutomationFires } from '@/lib/automations/fire-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type TriggerKind = 'manual' | 'cron';

interface PatchBody {
  name?: string;
  prompt?: string;
  runtime?: string;
  repoPath?: string;
  branch?: string;
  triggerKind?: TriggerKind;
  cronExpr?: string | null;
  enabled?: boolean;
  projectId?: string | null;
  catchUpPolicy?: 'latest' | 'all' | 'skip';
  repoConcurrencyLimit?: number;
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: PatchBody;
  try { body = await request.json() as PatchBody; }
  catch { return NextResponse.json({ error: 'invalid json body' }, { status: 400 }); }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'db unavailable' }, { status: 500 });
  const existing = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Compose the patch. Only set the fields the caller sent; respect existing
  // values for the rest. Cron recompute fires if EITHER triggerKind flipped to
  // cron OR cronExpr changed while staying on cron.
  const next: Partial<typeof automations.$inferInsert> = {
    updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  if (typeof body.name === 'string') next.name = body.name.trim();
  if (typeof body.prompt === 'string') next.prompt = body.prompt.trim();
  if (typeof body.runtime === 'string') next.runtime = body.runtime.trim();
  if (typeof body.repoPath === 'string') next.repoPath = body.repoPath.trim();
  if (typeof body.branch === 'string') next.branch = (body.branch.trim() || 'main');
  if (body.projectId !== undefined) next.projectId = body.projectId;
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (body.catchUpPolicy !== undefined) {
    if (!['latest', 'all', 'skip'].includes(body.catchUpPolicy)) {
      return NextResponse.json({ error: 'invalid catchUpPolicy' }, { status: 400 });
    }
    next.catchUpPolicy = body.catchUpPolicy;
  }
  if (body.repoConcurrencyLimit !== undefined) {
    if (!Number.isInteger(body.repoConcurrencyLimit) || body.repoConcurrencyLimit < 1 || body.repoConcurrencyLimit > 16) {
      return NextResponse.json({ error: 'repoConcurrencyLimit must be between 1 and 16' }, { status: 400 });
    }
    next.repoConcurrencyLimit = body.repoConcurrencyLimit;
  }

  const triggerKind: TriggerKind = body.triggerKind ?? existing.triggerKind as TriggerKind;
  const cronExpr = body.cronExpr !== undefined ? body.cronExpr : existing.cronExpr;
  if (body.triggerKind !== undefined || body.cronExpr !== undefined) {
    next.triggerKind = triggerKind;
    next.cronExpr = triggerKind === 'cron' ? cronExpr : null;
    if (triggerKind === 'cron') {
      if (!cronExpr) return NextResponse.json({ error: 'cronExpr required when triggerKind=cron' }, { status: 400 });
      if (!validateCron(cronExpr)) return NextResponse.json({ error: `invalid cron expression: ${cronExpr}` }, { status: 400 });
      next.nextRunAt = computeNextRunAt(cronExpr, Date.now());
    } else {
      next.nextRunAt = null;
    }
  }

  db.update(automations).set(next).where(eq(automations.id, id)).run();
  if (body.enabled === false) cancelAutomationFires(id);
  const updated = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!updated) return NextResponse.json({ error: 'update failed' }, { status: 500 });
  return NextResponse.json({ automation: automationApiRecord(updated) });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'db unavailable' }, { status: 500 });
  const existing = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });
  db.delete(automations).where(eq(automations.id, id)).run();
  return NextResponse.json({ ok: true });
}
