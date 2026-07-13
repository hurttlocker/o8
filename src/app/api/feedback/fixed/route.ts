import { NextResponse, type NextRequest } from 'next/server';
import { collectReceipts, markSeen } from '@/lib/feedback/fixed-feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The in-app receipt feed.
 *
 * GET  → reports THIS machine filed that have since been fixed and not yet shown.
 * POST → acknowledge them, so they stop nagging.
 *
 * Gated by the default-deny middleware like every other /api route. Nothing here
 * leaves the machine: the fix manifest is a public download, and the join against
 * the local ledger happens server-side, in-process.
 */

export async function GET() {
  try {
    const receipts = await collectReceipts();
    return NextResponse.json({ ok: true, receipts });
  } catch (error) {
    // A broken receipt must never break the dashboard that renders it.
    return NextResponse.json({
      ok: false,
      receipts: [],
      error: error instanceof Error ? error.message : 'Failed to load receipts.',
    });
  }
}

export async function POST(request: NextRequest) {
  let body: { ids?: unknown };
  try {
    body = (await request.json()) as { ids?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: 'Pass one or more report ids to acknowledge.' }, { status: 400 });
  }

  markSeen(ids);
  return NextResponse.json({ ok: true });
}
