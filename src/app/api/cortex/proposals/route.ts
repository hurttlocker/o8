/**
 * GET /api/cortex/proposals
 *   → { ok: true, proposals: DirectiveProposalCandidate[], computedAt: number }
 *
 * POST /api/cortex/proposals
 *   body: { action: 'dismiss', id: string, filePattern: string, fixPattern: string }
 *   → { ok: true, snoozedUntil: string }
 *
 * Read-only window into the auto-directive proposer (#746). Dismissals
 * append a 30-day snooze to ~/.o8/proposal-snooze.json — see
 * `src/lib/cortex/proposer.ts` for the algorithm.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { readCachedProposals, snoozeProposal } from '@/lib/cortex/proposer';

export function GET(request: NextRequest) {
  try {
    // #836 — `?force=1` (or `force=true`) bypasses the in-memory cache so
    // operators can always see fresh proposals after a directive change or
    // new outcome row, without restarting the server or waiting on the tick.
    const forceParam = request.nextUrl.searchParams.get('force');
    const force = forceParam === '1' || forceParam === 'true';
    const { candidates, computedAt } = readCachedProposals({ force });
    return NextResponse.json(
      { ok: true, proposals: candidates, computedAt },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load proposals.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

interface DismissBody {
  action?: string;
  id?: string;
  filePattern?: string;
  fixPattern?: string;
}

export async function POST(request: NextRequest) {
  let body: DismissBody | null = null;
  try {
    body = (await request.json()) as DismissBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body || body.action !== 'dismiss') {
    return NextResponse.json({ ok: false, error: 'Unsupported action.' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const filePattern = typeof body.filePattern === 'string' ? body.filePattern.trim() : '';
  const fixPattern = typeof body.fixPattern === 'string' ? body.fixPattern.trim() : '';
  if (!id || !filePattern || !fixPattern) {
    return NextResponse.json(
      { ok: false, error: 'id, filePattern, and fixPattern are required for dismiss.' },
      { status: 400 },
    );
  }

  try {
    const entry = snoozeProposal({ id, filePattern, fixPattern });
    return NextResponse.json(
      { ok: true, snoozedUntil: entry.snoozedUntil },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to snooze proposal.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
