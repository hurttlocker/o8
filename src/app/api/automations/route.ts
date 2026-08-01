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
import { eq, desc, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { computeNextRunAt, validateCron } from '@/lib/automations/cron';

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
}

function rowFromDb(row: typeof automations.$inferSelect) {
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
    lastRunAt: row.lastRunAt,
    lastRunStatus: row.lastRunStatus,
    lastLaneId: row.lastLaneId,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const owner = url.searchParams.get('owner');
  const db = getDb();
  if (!db) return NextResponse.json({ automations: [] });
  const rows = owner
    ? db.select().from(automations).where(eq(automations.owner, owner)).orderBy(desc(automations.createdAt)).all()
    : db.select().from(automations).orderBy(desc(automations.createdAt)).all();
  return NextResponse.json({ automations: rows.map(rowFromDb) });
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

  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  if (!owner) return NextResponse.json({ error: 'owner required' }, { status: 400 });
  if (!repoPath) return NextResponse.json({ error: 'repoPath required' }, { status: 400 });
  if (!runtime) return NextResponse.json({ error: 'runtime required' }, { status: 400 });
  if (!prompt) return NextResponse.json({ error: 'prompt required' }, { status: 400 });
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
    lastRunAt: null,
    lastRunStatus: 'idle',
    lastLaneId: null,
  }).run();

  const created = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!created) return NextResponse.json({ error: 'insert failed' }, { status: 500 });
  return NextResponse.json({ automation: rowFromDb(created) });
}
