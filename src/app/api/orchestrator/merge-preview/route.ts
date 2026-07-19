import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { previewPacketMerge } from '@/lib/lane/preview-merge';
import { branchUnresolvedPayload, LaneBranchUnresolvedError } from '@/lib/lane/review-target';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/orchestrator/merge-preview?packetId=<id>
 *
 * Dry-runs the 5-layer merge gate for one packet (no worktree mutation) and
 * returns `{ packetId, wouldMerge, checks[], blockers[], branch }` — the same
 * MergePreviewResult the `o8_merge_preview` MCP tool surfaces. The N-up compare
 * matrix renders this per column so the operator sees each candidate's GATE
 * VERDICT before picking — the governance signal the competitor's diff view can't show.
 * Gated by the global middleware (loopback + token under /api/orchestrator/).
 */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const packetId = request.nextUrl.searchParams.get('packetId')?.trim();
  if (!packetId) {
    return NextResponse.json({ error: 'packetId is required.' }, { status: 400 });
  }

  try {
    const preview = await previewPacketMerge(packetId);
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof LaneBranchUnresolvedError) {
      return NextResponse.json(branchUnresolvedPayload(error), { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'merge preview failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
