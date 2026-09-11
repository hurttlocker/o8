import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { archiveTerminalLanes } from '@/lib/lane/archive-terminal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * #2154 — clear every finished lane in one call.
 *
 * Operator-only: a packet-bound worker may archive its OWN lane through
 * `/api/lanes`, but clearing the rail is an operator gesture over every lane in
 * the registry. Naturally idempotent — a second call finds nothing terminal
 * left to archive and reports `archived: 0`, so no idempotency key is required.
 */
export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;
  const principal = resolveRequestPrincipalContext(req);
  if (principal.role !== 'operator') {
    return NextResponse.json(
      { ok: false, error: { code: 'operator_required', message: 'Clearing terminal lanes requires an operator credential.' } },
      { status: 403 },
    );
  }

  try {
    const result = await archiveTerminalLanes('user');
    return NextResponse.json({
      ok: true,
      archived: result.archived.length,
      laneIds: result.archived,
      sessionArchiveFailures: result.sessionArchiveFailures,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bulk archive failed.';
    return NextResponse.json({ ok: false, note: message }, { status: 500 });
  }
}
