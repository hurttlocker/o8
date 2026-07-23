/**
 * #796 — Read-only reader for the autonomous-loop cron state file.
 *
 * Schema of `~/.o8/loop-cron-state.json` (all fields optional except jobId):
 *   {
 *     "jobId":          "string",   // unique per scheduled job
 *     "cronExpression": "string",   // e.g. "0,20,40 * * * *"
 *     "lastFiredAt":    "ISO 8601",
 *     "nextFireAt":     "ISO 8601",
 *     "prompt":         "string"
 *   }
 *
 * If the file is missing or unparseable we respond with `{ ok: true,
 * active: false }` so the Loop Status widget can render "No active loop"
 * gracefully. We never create or mutate this file — the cron tooling owns
 * its lifecycle.
 *
 * Middleware in `src/middleware.ts` already gates `/api/panel/*` on
 * loopback + ws-token, so no extra auth here.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

interface CronStatePayload {
  ok: boolean;
  active: boolean;
  jobId: string | null;
  cronExpression: string | null;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  prompt: string | null;
  note?: string;
}

function emptyResponse(note?: string): CronStatePayload {
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

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export async function GET(): Promise<NextResponse<CronStatePayload>> {
  const filePath = path.join(getDataDir(), 'loop-cron-state.json');

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
    if (code === 'ENOENT') {
      return NextResponse.json(emptyResponse('Cron state file not present.'));
    }
    return NextResponse.json(emptyResponse('Cron state file unreadable.'));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return NextResponse.json(emptyResponse('Cron state file is not valid JSON.'));
  }

  if (!parsed || typeof parsed !== 'object') {
    return NextResponse.json(emptyResponse('Cron state payload not an object.'));
  }

  const record = parsed as Record<string, unknown>;
  const jobId = pickString(record.jobId);
  const cronExpression = pickString(record.cronExpression);
  const lastFiredAt = pickString(record.lastFiredAt);
  const nextFireAt = pickString(record.nextFireAt);
  const prompt = pickString(record.prompt);

  // We treat "active" as: file exists AND has at least a jobId or a cron
  // expression. That keeps a half-written file from masquerading as live.
  const active = !!(jobId || cronExpression);

  return NextResponse.json({
    ok: true,
    active,
    jobId,
    cronExpression,
    lastFiredAt,
    nextFireAt,
    prompt,
  });
}
