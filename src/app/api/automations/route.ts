/**
 * /api/automations — list + create automations (cron-style scheduled runs).
 *
 * GET   → { automations: AutomationRow[] }
 * POST  → { automation: AutomationRow } | 4xx
 *
 * Gated by middleware loopback + ws-token (see GATED_PREFIXES in middleware.ts).
 * Owner is derived from the request body for now (single-user model). When
 * Team automations land (P3) the owner will come from the auth bridge.
 */

import { NextResponse } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { computeNextRunAt, validateCron } from '@/lib/automations/cron';
import { automationApiRecord } from '@/lib/automations/api-shape';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type TriggerKind = 'manual' | 'cron';

interface CreateBody {
  name?: string;
  owner?: string;
  projectId?: string | null;
  repoPath?: string;
  branch?: string;
  runtime?: string;
  prompt?: string;
  triggerKind?: TriggerKind;
  cronExpr?: string | null;
  enabled?: boolean;
  catchUpPolicy?: 'latest' | 'all' | 'skip';
  repoConcurrencyLimit?: number;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const owner = url.searchParams.get('owner');
  const db = getDb();
  if (!db) return NextResponse.json({ automations: [] });
  const rows = owner
    ? db.select().from(automations).where(eq(automations.owner, owner)).orderBy(desc(automations.createdAt)).all()
    : db.select().from(automations).orderBy(desc(automations.createdAt)).all();
  return NextResponse.json({ automations: rows.map(automationApiRecord) });
}

export async function POST(request: Request) {
  let body: CreateBody;
  try {
    body = await request.json() as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const name = (body.name ?? '').trim();
  const owner = (body.owner ?? '').trim();
  const repoPath = (body.repoPath ?? '').trim();
  const runtime = (body.runtime ?? '').trim();
  const prompt = (body.prompt ?? '').trim();
  const triggerKind: TriggerKind = body.triggerKind === 'cron' ? 'cron' : 'manual';
  const branch = (body.branch ?? 'main').trim() || 'main';
  const cronExpr = body.cronExpr ? body.cronExpr.trim() : null;
  const catchUpPolicy = body.catchUpPolicy === 'all' || body.catchUpPolicy === 'skip'
    ? body.catchUpPolicy
    : 'latest';
  const repoConcurrencyLimit = Number.isInteger(body.repoConcurrencyLimit)
    ? Number(body.repoConcurrencyLimit)
    : 1;

  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  if (!owner) return NextResponse.json({ error: 'owner required' }, { status: 400 });
  if (!repoPath) return NextResponse.json({ error: 'repoPath required' }, { status: 400 });
  if (!runtime) return NextResponse.json({ error: 'runtime required' }, { status: 400 });
  if (!prompt) return NextResponse.json({ error: 'prompt required' }, { status: 400 });
  if (repoConcurrencyLimit < 1 || repoConcurrencyLimit > 16) {
    return NextResponse.json({ error: 'repoConcurrencyLimit must be between 1 and 16' }, { status: 400 });
  }
  if (triggerKind === 'cron') {
    if (!cronExpr) return NextResponse.json({ error: 'cronExpr required when triggerKind=cron' }, { status: 400 });
    if (!validateCron(cronExpr)) return NextResponse.json({ error: `invalid cron expression: ${cronExpr}` }, { status: 400 });
  }

  const id = `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const nextRunAt = triggerKind === 'cron' && cronExpr ? computeNextRunAt(cronExpr, now) : null;
  const enabled = body.enabled !== false;

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'db unavailable' }, { status: 500 });
  db.insert(automations).values({
    id,
    name,
    owner,
    projectId: body.projectId ?? null,
    repoPath,
    branch,
    runtime,
    prompt,
    triggerKind,
    cronExpr,
    enabled,
    nextRunAt,
    catchUpPolicy,
    repoConcurrencyLimit,
    lastRunAt: null,
    lastRunStatus: 'idle',
    lastLaneId: null,
  }).run();

  const created = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!created) return NextResponse.json({ error: 'insert failed' }, { status: 500 });
  return NextResponse.json({ automation: automationApiRecord(created) });
}
