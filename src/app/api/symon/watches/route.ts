/**
 * /api/symon/watches — Symon's standing-intent surface over the durable watch
 * engine.
 *
 * GET  → { watches: SymonWatchRecord[] }        optional ?sessionId=
 * POST → { watch: SymonWatchRecord } | 4xx      registers one watch
 *
 * Loopback + ws-token gated by middleware, like every other /api/symon route.
 * The native Symon tools reach it through the agent's o8 HTTP bridge.
 */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { getDb } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import {
  ingestLaneAutomationSourceEvents,
  latestAutomationSourceSequence,
} from '@/lib/automations/source-events';
import {
  listSymonWatches,
  parseSymonWatchThen,
  recordSymonWatchRegistered,
  symonWatchRecord,
} from '@/lib/automations/symon-watch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SOURCE_KINDS = ['managed_run', 'packet', 'repository'] as const;
const MAX_DEADLINE_MS = 7 * 24 * 60 * 60 * 1_000;

interface CreateBody {
  sessionId?: string;
  condition?: {
    text?: string;
    source?: 'managed_run' | 'packet' | 'repository';
    id?: string | null;
    events?: string[];
    repoPath?: string | null;
  };
  then?: unknown;
  deadlineMs?: number;
}

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get('sessionId');
  return NextResponse.json({ watches: listSymonWatches(sessionId) });
}

export async function POST(request: Request) {
  let body: CreateBody;
  try {
    body = await request.json() as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const condition = body.condition ?? {};
  const text = (condition.text ?? '').trim();
  const source = condition.source;
  const events = (condition.events ?? []).map((value) => String(value).trim()).filter(Boolean);
  const sourceId = condition.id?.trim() || null;
  const repoPath = condition.repoPath?.trim() || '';
  const sessionId = body.sessionId?.trim() || null;

  if (!text) return NextResponse.json({ error: 'condition.text required' }, { status: 400 });
  if (text.length > 200) return NextResponse.json({ error: 'condition.text must be 200 characters or fewer' }, { status: 400 });
  if (!source || !SOURCE_KINDS.includes(source)) {
    return NextResponse.json({ error: `condition.source must be one of ${SOURCE_KINDS.join(', ')}` }, { status: 400 });
  }
  if (events.length > 16 || events.some((value) => value.length > 80)) {
    return NextResponse.json({ error: 'condition.events accepts at most 16 values of 80 characters' }, { status: 400 });
  }
  if (sourceId && sourceId.length > 256) {
    return NextResponse.json({ error: 'condition.id must be 256 characters or fewer' }, { status: 400 });
  }
  const then = parseSymonWatchThen(body.then);
  if ('error' in then) return NextResponse.json({ error: then.error }, { status: 400 });

  const now = Date.now();
  const deadlineMs = body.deadlineMs ?? 24 * 60 * 60 * 1_000;
  if (!Number.isFinite(deadlineMs) || deadlineMs < 60_000 || deadlineMs > MAX_DEADLINE_MS) {
    return NextResponse.json({ error: 'deadlineMs must be between 60000 and 604800000' }, { status: 400 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'db unavailable' }, { status: 500 });

  if (source === 'packet') ingestLaneAutomationSourceEvents(1_000, now);
  const watchCheckpoint = latestAutomationSourceSequence({
    sourceKind: source,
    repoPath: repoPath || null,
    sourceId,
  });

  const id = `watch_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db.insert(automations).values({
    id,
    name: text,
    owner: 'symon',
    repoPath,
    branch: 'main',
    runtime: 'codex',
    // A Symon watch never launches a lane; the prompt exists because the shared
    // automation row requires one and it keeps the operator's words auditable.
    prompt: text,
    triggerKind: 'watch',
    enabled: true,
    repoConcurrencyLimit: 8,
    watchSourceKind: source,
    watchSourceId: sourceId,
    watchEventTypesJson: JSON.stringify(events),
    watchExpiresAt: now + deadlineMs,
    watchActionKind: then.kind === 'plan' ? 'symon_plan' : 'symon_report',
    watchCheckpoint,
    symonSessionId: sessionId,
    symonThenJson: JSON.stringify(then),
    lastRunStatus: 'idle',
  }).run();

  const created = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!created) return NextResponse.json({ error: 'insert failed' }, { status: 500 });
  recordSymonWatchRegistered(created, now);
  return NextResponse.json({ watch: symonWatchRecord(created) });
}
