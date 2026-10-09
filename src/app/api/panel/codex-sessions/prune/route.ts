import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { requirePanelAuth } from '@/lib/panel/auth';
import { pruneCodexSessions, UnsupportedCodexTranscriptRetentionError, type CodexSessionPruneMode } from '@/lib/codex/sessions-prune';

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

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipal(request) !== 'operator') {
    return response({ ok: false, code: 'forbidden', error: 'Transcript retention is operator-only.' }, 403);
  }
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
    return await pruneCodexSessions({ mode, maxAgeDays });
  } catch (error) {
    if (error instanceof UnsupportedCodexTranscriptRetentionError) {
      return response({
        ok: false,
        code: error.code,
        error: error.message,
        held: true,
        reason: 'external_provider_ownership',
        capabilities: error.capabilities,
        mode,
        maxAgeDays,
      }, 409);
    }
    const message = error instanceof Error ? error.message : 'Failed to prune codex sessions.';
    console.error('[panel-codex-sessions-prune] Failed to prune codex sessions:', message);
    return response({ error: message }, 500);
  }
}
