import { NextRequest, NextResponse } from 'next/server';

import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { findLatestLaneByPacket, getLane } from '@/lib/lane/registry';
import { readLaneReviewDiff } from '@/lib/lane/review-source';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  ArchitectureDeltaInputError,
  buildArchitectureDelta,
  unavailableArchitectureDelta,
} from '@/lib/review/architecture-delta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const laneId = request.nextUrl.searchParams.get('lane')?.trim() || null;
  const workspace = request.nextUrl.searchParams.get('workspace')?.trim() || null;
  if (!laneId && !workspace) {
    return NextResponse.json({ ok: false, error: 'A review lane or workspace is required.' }, { status: 400 });
  }

  try {
    if (laneId) {
      const lane = getLane(laneId) ?? findLatestLaneByPacket(laneId);
      if (!lane) {
        return NextResponse.json({ ok: false, error: 'No review lane found for that id or packet.' }, { status: 404 });
      }
      const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(request), lane.packetId);
      if (ownershipRefusal) {
        return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
      }
      const review = await readLaneReviewDiff(lane);
      if (review.source.kind !== 'materialized') {
        return NextResponse.json(unavailableArchitectureDelta(
          'Architecture delta currently requires a materialized packet workspace.',
        ), { headers: { 'Cache-Control': 'no-store, max-age=0' } });
      }
      const baseRef = review.diffBase.mergeBase ?? review.diffBase.comparisonRef;
      return NextResponse.json(await buildArchitectureDelta({ repoPath: review.source.cwd, baseRef }), {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    if (!workspace) {
      return NextResponse.json({ ok: false, error: 'A review workspace is required.' }, { status: 400 });
    }
    return NextResponse.json(await buildArchitectureDelta({ repoPath: workspace }), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to build the architecture delta.';
    const status = error instanceof ArchitectureDeltaInputError ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
