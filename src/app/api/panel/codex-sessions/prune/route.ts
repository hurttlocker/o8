import { NextResponse } from 'next/server';
import { invalidateCodexDiscoveredFleetCache } from '@/lib/codex/sessions';
import { pruneCodexSessions, type CodexSessionPruneMode } from '@/lib/codex/sessions-prune';
import { invalidateRuntimeInventoryCache } from '@/lib/runtime/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

type PruneRequestBody = {
  maxAgeDays?: unknown;
  mode?: unknown;
};

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function normalizeMode(value: unknown): CodexSessionPruneMode {
  if (value === undefined) {
    return 'archive';
  }
  if (value === 'archive' || value === 'delete') {
    return value;
  }
  throw new Error('mode must be "archive" or "delete".');
}

function normalizeMaxAgeDays(value: unknown) {
  if (value === undefined) {
    return 14;
  }

  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN;

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3650) {
    throw new Error('maxAgeDays must be an integer between 1 and 3650.');
  }

  return Math.floor(parsed);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as PruneRequestBody;

  let mode: CodexSessionPruneMode;
  let maxAgeDays: number;

  try {
    mode = normalizeMode(body.mode);
    maxAgeDays = normalizeMaxAgeDays(body.maxAgeDays);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid codex session prune request.';
    return response({ error: message }, 400);
  }

  try {
    const result = await pruneCodexSessions({ mode, maxAgeDays });

    invalidateCodexDiscoveredFleetCache();
    invalidateRuntimeInventoryCache();

    return response({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to prune codex sessions.';
    console.error('[panel-codex-sessions-prune] Failed to prune codex sessions:', message);
    return response({ error: message }, 500);
  }
}
