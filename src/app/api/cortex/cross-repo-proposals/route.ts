/**
 * GET /api/cortex/cross-repo-proposals
 *   → { ok: true, proposals: CrossRepoProposalCandidate[], computedAt: number }
 *
 * POST /api/cortex/cross-repo-proposals
 *   body: { action: 'dismiss', targetRepoId: string, directiveId: string }
 *   → { ok: true, snoozedUntil: string }
 *
 *   body: { action: 'accept', directiveId: string, originRepoId: string }
 *   → { ok: true, recordedAt: string }
 *   #855 — Records the source repo as the directive's origin in
 *   `~/.o8/directive-origins.json` so the next proposer tick won't propose
 *   the directive back to its origin (circular propagation guard). Caller
 *   (UI) should fire this immediately on Accept, before the chat composer
 *   handoff. Acceptance still flows through the orchestrator — this just
 *   stamps provenance.
 *
 * Cross-repo learning surface for #748. Read-only window into the
 * proposer cache; dismissals snooze a (targetRepoId, directiveId) pair for
 * 30 days. Always human-gated — Accept never auto-writes a directive.
 *
 * Gated by middleware (loopback + ws-token) under the `/api/cortex/` prefix.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import {
  readCachedCrossRepoProposals,
  recordDirectiveOrigin,
  snoozeCrossRepoProposal,
} from '@/lib/cortex/cross-repo-proposer';

export async function GET(request: NextRequest) {
  try {
    // #851 — `?force=1` (or `force=true`) bypasses the in-memory cache so
    // operators see fresh cross-repo proposals immediately after a registry
    // change, directive write, or outcome row, without waiting on the tick.
    const forceParam = request.nextUrl.searchParams.get('force');
    const force = forceParam === '1' || forceParam === 'true';
    const { candidates, computedAt } = await readCachedCrossRepoProposals({ force });
    return NextResponse.json(
      { ok: true, proposals: candidates, computedAt },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load cross-repo proposals.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

interface PostBody {
  action?: string;
  targetRepoId?: string;
  directiveId?: string;
  /** #855 — required when action='accept'. Source repo of the directive. */
  originRepoId?: string;
}

export async function POST(request: NextRequest) {
  let body: PostBody | null = null;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body) {
    return NextResponse.json({ ok: false, error: 'Empty body.' }, { status: 400 });
  }

  if (body.action === 'dismiss') {
    const targetRepoId = typeof body.targetRepoId === 'string' ? body.targetRepoId.trim() : '';
    const directiveId = typeof body.directiveId === 'string' ? body.directiveId.trim() : '';
    if (!targetRepoId || !directiveId) {
      return NextResponse.json(
        { ok: false, error: 'targetRepoId and directiveId are required for dismiss.' },
        { status: 400 },
      );
    }
    try {
      const entry = snoozeCrossRepoProposal({ targetRepoId, directiveId });
      return NextResponse.json(
        { ok: true, snoozedUntil: entry.snoozedUntil },
        { headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to snooze proposal.';
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  }

  if (body.action === 'accept') {
    const directiveId = typeof body.directiveId === 'string' ? body.directiveId.trim() : '';
    const originRepoId = typeof body.originRepoId === 'string' ? body.originRepoId.trim() : '';
    if (!directiveId || !originRepoId) {
      return NextResponse.json(
        { ok: false, error: 'directiveId and originRepoId are required for accept.' },
        { status: 400 },
      );
    }
    try {
      const entry = recordDirectiveOrigin({ directiveId, originRepoId });
      return NextResponse.json(
        { ok: true, recordedAt: entry.recordedAt },
        { headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to record origin.';
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: false, error: 'Unsupported action.' }, { status: 400 });
}
