/**
 * #899 — Dismiss an AI suggestion.
 *
 * POST /api/projects/suggest/dismiss
 *   { suggestionId: string, reason?: string }
 *
 * Records the suggestion id in the dismissed_suggestions table so
 * Stage 2 will not re-suggest it, and removes it from the live cache.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { recordDismissedSuggestion } from '@/lib/projects/store';
import { removeSuggestionFromCache } from '@/lib/projects/suggest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  let body: { suggestionId?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as { suggestionId?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const suggestionId = typeof body.suggestionId === 'string' ? body.suggestionId.trim() : '';
  if (!suggestionId) {
    return NextResponse.json({ error: 'suggestionId is required.' }, { status: 400 });
  }

  const reason = typeof body.reason === 'string' ? body.reason : null;

  try {
    recordDismissedSuggestion(suggestionId, reason);
    const removed = removeSuggestionFromCache(suggestionId);
    return NextResponse.json({ ok: true, removedFromCache: removed }, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to dismiss suggestion.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
