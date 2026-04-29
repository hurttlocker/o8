/**
 * #798 — Writer for the autonomous-loop cron state file.
 *
 * Companion to the read-only `/api/panel/loop-status` endpoint shipped in
 * #797. Today nothing writes `~/.o8/loop-cron-state.json`, so the Loop
 * Status widget always shows "No active loop." This route is the missing
 * writer.
 *
 * Schema of `~/.o8/loop-cron-state.json` (matches the reader exactly):
 *   {
 *     "jobId":          "string",   // unique per scheduled job
 *     "cronExpression": "string",
 *     "prompt":         "string",
 *     "armedAt":        "ISO 8601",
 *     "lastFiredAt":    "ISO 8601 | null",
 *     "nextFireAt":     "ISO 8601 | null",
 *     "status":         "armed" | "disarmed",
 *     "disarmedAt":     "ISO 8601" (only when status === 'disarmed')
 *   }
 *
 * Write actions:
 *   POST { action: 'arm', jobId, cronExpression, prompt, nextFireAt? }
 *     → fresh state, status: 'armed', lastFiredAt: null
 *   POST { action: 'tick', nextFireAt? }
 *     → reads existing, updates lastFiredAt = now and (optionally) nextFireAt
 *   POST { action: 'disarm' }
 *     → unlinks the file (cleanest signal — reader treats absence as inactive)
 *
 * Read action:
 *   GET → same payload shape as `/api/panel/loop-status` for symmetry.
 *
 * Atomic temp-file rename mirrors the recall-metrics.json pattern from #749
 * so a crash mid-write never leaves a half-written JSON file on disk.
 *
 * Middleware in `src/middleware.ts` already gates `/api/panel/*` on
 * loopback + ws-token, so no extra auth here.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface LoopStatePayload {
  ok: boolean;
  active: boolean;
  jobId: string | null;
  cronExpression: string | null;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  prompt: string | null;
  status?: string | null;
  armedAt?: string | null;
  disarmedAt?: string | null;
  note?: string;
}

interface PersistedState {
  jobId?: string;
  cronExpression?: string;
  prompt?: string;
  armedAt?: string;
  lastFiredAt?: string | null;
  nextFireAt?: string | null;
  status?: 'armed' | 'disarmed';
  disarmedAt?: string;
}

function stateFilePath(): string {
  // Mirrors the reader at /api/panel/loop-status — must stay in sync. We
  // resolve via os.homedir() rather than getDataDir() because the reader
  // hardcodes ~/.o8 and dual sources would drift. If the data-dir override
  // becomes important later, both endpoints flip together.
  return path.join(os.homedir(), '.o8', 'loop-cron-state.json');
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function emptyResponse(note?: string): LoopStatePayload {
  return {
    ok: true,
    active: false,
    jobId: null,
    cronExpression: null,
    lastFiredAt: null,
    nextFireAt: null,
    prompt: null,
    ...(note ? { note } : {}),
  };
}

async function readState(): Promise<PersistedState | null> {
  const filePath = stateFilePath();
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
    if (code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as PersistedState;
  } catch {
    return null;
  }
}

async function writeStateAtomic(state: PersistedState): Promise<void> {
  const filePath = stateFilePath();
  const tmp = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, filePath);
}

async function unlinkState(): Promise<void> {
  const filePath = stateFilePath();
  if (!existsSync(filePath)) return;
  try {
    await unlink(filePath);
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
    if (code === 'ENOENT') return;
    throw err;
  }
}

function shapeResponse(state: PersistedState | null): LoopStatePayload {
  if (!state) return emptyResponse('Cron state file not present.');
  const jobId = pickString(state.jobId);
  const cronExpression = pickString(state.cronExpression);
  const lastFiredAt = pickString(state.lastFiredAt ?? null);
  const nextFireAt = pickString(state.nextFireAt ?? null);
  const prompt = pickString(state.prompt);
  const status = pickString(state.status ?? null);
  const armedAt = pickString(state.armedAt ?? null);
  const disarmedAt = pickString(state.disarmedAt ?? null);

  // Mirror loop-status' definition: active iff a job identifier or cron
  // expression survives validation AND the status isn't explicitly disarmed.
  const isDisarmed = status === 'disarmed';
  const active = !isDisarmed && !!(jobId || cronExpression);

  return {
    ok: true,
    active,
    jobId,
    cronExpression,
    lastFiredAt,
    nextFireAt,
    prompt,
    status,
    armedAt,
    disarmedAt,
  };
}

export async function GET(): Promise<NextResponse<LoopStatePayload>> {
  try {
    const state = await readState();
    return NextResponse.json(shapeResponse(state));
  } catch (err) {
    console.warn('[loop-state] GET failed:', err instanceof Error ? err.message : err);
    return NextResponse.json(emptyResponse('Cron state file unreadable.'));
  }
}

interface PostBody {
  action?: unknown;
  jobId?: unknown;
  cronExpression?: unknown;
  prompt?: unknown;
  nextFireAt?: unknown;
}

interface ErrorBody {
  ok: false;
  error: string;
}

type PostResponse = LoopStatePayload | ErrorBody;

function badRequest(message: string): NextResponse<ErrorBody> {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

export async function POST(req: NextRequest): Promise<NextResponse<PostResponse>> {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return badRequest('Body must be valid JSON.');
  }

  const action = pickString(body.action);
  if (!action) return badRequest('Missing required field: action.');

  const now = new Date().toISOString();

  try {
    if (action === 'arm') {
      const jobId = pickString(body.jobId);
      const cronExpression = pickString(body.cronExpression);
      const prompt = pickString(body.prompt);
      if (!jobId) return badRequest('arm requires jobId.');
      if (!cronExpression) return badRequest('arm requires cronExpression.');
      if (!prompt) return badRequest('arm requires prompt.');

      const nextFireAt = pickString(body.nextFireAt);
      const next: PersistedState = {
        jobId,
        cronExpression,
        prompt,
        armedAt: now,
        lastFiredAt: null,
        nextFireAt,
        status: 'armed',
      };
      await writeStateAtomic(next);
      return NextResponse.json(shapeResponse(next));
    }

    if (action === 'tick') {
      const existing = await readState();
      if (!existing || !pickString(existing.jobId)) {
        return badRequest('tick requires an armed loop — no state file present.');
      }
      const nextFireAt = pickString(body.nextFireAt) ?? pickString(existing.nextFireAt ?? null);
      const next: PersistedState = {
        ...existing,
        lastFiredAt: now,
        nextFireAt,
        status: existing.status === 'disarmed' ? 'armed' : (existing.status ?? 'armed'),
      };
      // If the caller wanted to re-arm a disarmed entry by ticking it, the
      // disarmedAt field becomes stale — drop it so the reader doesn't
      // surface a misleading timestamp.
      if (next.status === 'armed') delete next.disarmedAt;
      await writeStateAtomic(next);
      return NextResponse.json(shapeResponse(next));
    }

    if (action === 'disarm') {
      // Cleanest signal: unlink the file. The reader treats ENOENT as
      // "no active loop," which is exactly what disarm means.
      await unlinkState();
      return NextResponse.json(emptyResponse('Loop disarmed.'));
    }

    return badRequest(`Unknown action: ${action}. Expected arm, tick, or disarm.`);
  } catch (err) {
    console.warn('[loop-state] POST failed:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false as const, error: err instanceof Error ? err.message : 'write failed' },
      { status: 500 },
    );
  }
}
