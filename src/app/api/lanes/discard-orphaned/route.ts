import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { discardOrphanedLane } from '@/lib/lane/orphaned-lane';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * #2144 — discard a lane whose packet worktree is no longer on disk.
 *
 * Operator-only, and never automatic: this is the control behind the Review
 * tab's "worktree no longer on disk" state. It does NOT relax
 * `/api/runtime/archive`'s terminal guard — it is a separate path that earns
 * the write by proving the checkout is gone first (see `orphanedDiscardRefusal`),
 * so a lane with work still on disk is refused here as well.
 *
 * Idempotent in practice: a second call finds the lane already archived and
 * refuses with `already_terminal`.
 */
export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;
  const principal = resolveRequestPrincipalContext(req);
  if (principal.role !== 'operator') {
    return NextResponse.json(
      { ok: false, error: { code: 'operator_required', message: 'Discarding a lane requires an operator credential.' } },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null) as { laneId?: string } | null;
  const laneId = body?.laneId?.trim();
  if (!laneId) {
    return NextResponse.json({ ok: false, error: { code: 'lane_id_required', message: 'laneId is required.' } }, { status: 400 });
  }

  try {
    const result = await discardOrphanedLane(laneId, 'user');
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.refusal },
        { status: result.refusal.code === 'lane_not_found' ? 404 : 409, headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }
    return NextResponse.json(
      { ok: true, laneId: result.lane.id, status: result.lane.status },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Discard failed.';
    return NextResponse.json({ ok: false, note: message }, { status: 500 });
  }
}
