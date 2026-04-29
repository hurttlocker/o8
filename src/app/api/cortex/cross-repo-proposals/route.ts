/**
 * GET /api/cortex/cross-repo-proposals
 *   → { ok: true, proposals: CrossRepoProposalCandidate[], computedAt: number }
 *
 * POST /api/cortex/cross-repo-proposals
 *   body: { action: 'dismiss', targetRepoId: string, directiveId: string }
 *   → { ok: true, snoozedUntil: string }
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
  snoozeCrossRepoProposal,
} from '@/lib/cortex/cross-repo-proposer';

export async function GET() {
  try {
    const { candidates, computedAt } = await readCachedCrossRepoProposals();
    return NextResponse.json(
      { ok: true, proposals: candidates, computedAt },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load cross-repo proposals.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

interface DismissBody {
  action?: string;
  targetRepoId?: string;
  directiveId?: string;
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
