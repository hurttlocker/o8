export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { type SymonTextPlannerSelection } from '@/lib/mobile/symon-text-eval';
import {
  pollSymonTextInterrupt,
  pollSymonTextTurn,
} from '@/lib/mobile/symon-text-bridge-client';

const POLL_WINDOW_MS = 3_000;

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const turnId = typeof body?.turnId === 'string' ? body.turnId : '';
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  const planner = body?.planner && typeof body.planner === 'object' && !Array.isArray(body.planner)
    ? body.planner as Record<string, unknown>
    : null;
  const selection: SymonTextPlannerSelection | null = planner
    && (planner.engine === 'claude' || planner.engine === 'codex')
    && typeof planner.model === 'string'
    && typeof planner.effort === 'string'
    ? { engine: planner.engine, model: planner.model, effort: planner.effort }
    : null;
  if (!sessionId || !turnId || !prompt || !selection) {
    return NextResponse.json({ ok: false, state: 'error', error: 'bad_request' }, { status: 400 });
  }
  try {
    const result = await pollSymonTextTurn({
      sessionId,
      turnId,
      prompt,
      planner: selection,
    }, POLL_WINDOW_MS);
    return NextResponse.json({ ok: result.state !== 'error', ...result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      state: 'error',
      error: 'desktop_unavailable',
      detail: error instanceof Error ? error.message : 'Webview bridge failed.',
    });
  }
}

export async function DELETE(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const turnId = typeof body?.turnId === 'string' ? body.turnId : '';
  if (!sessionId || !turnId) {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  try {
    const result = await pollSymonTextInterrupt(sessionId, turnId, POLL_WINDOW_MS);
    return NextResponse.json({ ok: result.state === 'done', ...result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      state: 'error',
      error: 'desktop_unavailable',
      detail: error instanceof Error ? error.message : 'Webview bridge failed.',
    }, { status: 503 });
  }
}
