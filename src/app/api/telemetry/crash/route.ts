/**
 * POST /api/telemetry/crash — renderer crash sink.
 *
 * The desktop renderer (TelemetryCrashCapture) POSTs window 'error' /
 * 'unhandledrejection' events here; the server sanitizes them and appends to the
 * same crash store the process-level capture writes to. Gated by the default-deny
 * middleware (loopback / ws-token) like every other /api route — no allowlist
 * entry. NEVER throws: always returns a structured JSON body.
 */

import { NextResponse } from 'next/server';

import { appendCrashLine, buildCrashRecord, type CrashKind } from '@/lib/telemetry/crash-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: NO_STORE });
}

function resolveKind(raw: unknown): CrashKind {
  return raw === 'window.unhandledrejection' ? 'window.unhandledrejection' : 'window.error';
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json({ ok: false, error: 'Invalid request body.' }, 400);
    }
    const record = body as Record<string, unknown>;
    // The server stamps appVersion + ts; the client only supplies message/stack.
    await appendCrashLine(
      buildCrashRecord({
        source: typeof record.source === 'string' ? record.source : 'renderer',
        kind: resolveKind(record.kind),
        message: record.message,
        stack: record.stack,
      }),
    );
    return json({ ok: true });
  } catch (error) {
    // Structured error — never throw out of an API route.
    console.error('[telemetry] crash route error:', error instanceof Error ? error.message : error);
    return json({ ok: false, error: 'Failed to record crash.' }, 200);
  }
}
