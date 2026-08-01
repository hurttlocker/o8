import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { getPacketScope } from '@/lib/lanes/scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id } = await params;
  const scope = await getPacketScope({ laneId: id })
    ?? await getPacketScope({ packetId: id });
  if (!scope) {
    return NextResponse.json({ ok: false, note: 'Packet scope not found.' }, { status: 404 });
  }
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(req), scope.packetId);
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }

  return NextResponse.json(scope, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
