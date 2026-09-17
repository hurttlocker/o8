/**
 * /api/symon/watches/[id] — read, run, and cancel one standing watch.
 *
 * GET    → { watch, plan? }  `plan` appears only for a parked plan-bodied watch
 * PATCH  → { watch }         settles a symon_watch_run outcome
 * DELETE → { watch }         cancels the watch
 */
import { NextResponse } from 'next/server';

import {
  cancelSymonWatch,
  claimSymonWatchPlanBody,
  getSymonWatch,
  settleSymonWatchRun,
  symonWatchRecord,
} from '@/lib/automations/symon-watch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RUN_OUTCOMES = ['approved', 'denied', 'failed'] as const;

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = getSymonWatch(id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const plan = claimSymonWatchPlanBody(id);
  return NextResponse.json({
    watch: symonWatchRecord(row),
    plan: plan.ok ? { steps: plan.steps, condition: plan.condition } : null,
    planError: plan.ok ? null : plan.error,
  });
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { runOutcome?: string; detail?: string };
  try {
    body = await request.json() as { runOutcome?: string; detail?: string };
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }
  const outcome = body.runOutcome;
  if (!outcome || !(RUN_OUTCOMES as readonly string[]).includes(outcome)) {
    return NextResponse.json({ error: `runOutcome must be one of ${RUN_OUTCOMES.join(', ')}` }, { status: 400 });
  }
  const watch = settleSymonWatchRun(
    id,
    outcome as (typeof RUN_OUTCOMES)[number],
    (body.detail ?? '').slice(0, 400),
  );
  if (!watch) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ watch });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const watch = cancelSymonWatch(id);
  if (!watch) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ watch });
}
