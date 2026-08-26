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
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { readCachedProposals, snoozeProposal } from '@/lib/cortex/proposer';
import { dismissObservationProposal, proposeObservation, readObservationProposals } from '@/lib/cortex/proposals';
import { getLane } from '@/lib/lane/registry';

export function GET(request: NextRequest) {
  try {
    // #836 — `?force=1` (or `force=true`) bypasses the in-memory cache so
    // operators can always see fresh proposals after a directive change or
    // new outcome row, without restarting the server or waiting on the tick.
    const forceParam = request.nextUrl.searchParams.get('force');
    const force = forceParam === '1' || forceParam === 'true';
    const { candidates, computedAt } = readCachedProposals({ force });
    return NextResponse.json(
      { ok: true, proposals: [...readObservationProposals(), ...candidates], computedAt },
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
  packetId?: string;
  laneId?: string;
  proposed_by?: string;
  kind?: string;
  text?: string;
  scope?: string;
}

function forbidden(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 403 });
}

export async function POST(request: NextRequest) {
  let body: DismissBody | null = null;
  try {
    body = (await request.json()) as DismissBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const principal = resolveRequestPrincipalContext(request);
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    return forbidden(
      'operator_or_worker_required',
      'Proposal mutations require an operator or packet-bound worker credential.',
    );
  }
  if (principal.role === 'worker' && body?.action !== 'propose_observation') {
    return forbidden('operator_required', 'Only an operator may mutate existing proposals.');
  }

  if (body?.action === 'propose_observation') {
    try {
      let proposalInput: DismissBody = body;
      if (principal.role === 'worker') {
        const ownershipRefusal = workerPacketRefusal(principal, body.packetId);
        if (ownershipRefusal) {
          return forbidden(ownershipRefusal.code, ownershipRefusal.message);
        }
        const packetId = principal.packetId;
        if (!packetId) {
          return forbidden(
            'worker_packet_required',
            'Worker observations require a packet-bound credential.',
          );
        }
        const laneId = typeof body.laneId === 'string' ? body.laneId.trim() : '';
        const lane = laneId ? getLane(laneId) : null;
        if (!lane || lane.packetId !== packetId) {
          return forbidden(
            'worker_lane_mismatch',
            'Worker observations must name a lane owned by the authenticated packet.',
          );
        }
        proposalInput = {
          ...body,
          packetId,
          laneId: lane.id,
          proposed_by: packetId,
        };
      }
      const proposal = proposeObservation(proposalInput);
      return NextResponse.json({ ok: true, proposal }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to propose observation.';
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }
  }
  if (body?.action === 'dismiss_observation') {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) return NextResponse.json({ ok: false, error: 'id is required.' }, { status: 400 });
    return NextResponse.json({ ok: true, dismissed: dismissObservationProposal(id) }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
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
