import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { findLanesTouching, findLanesTouchingPacketDiff } from '@/lib/lane/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parsePathParams(params: URLSearchParams) {
  return Array.from(new Set(
    params
      .getAll('path')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean),
  ));
}

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const repo = url.searchParams.get('repo');
  const packetId = url.searchParams.get('packet')?.trim() || null;
  const paths = parsePathParams(url.searchParams);

  try {
    if (packetId) {
      const result = findLanesTouchingPacketDiff(packetId, { repo });
      if (!result) {
        return NextResponse.json({ ok: false, note: 'Packet lane not found.' }, { status: 404 });
      }

      return NextResponse.json({
        schema: 'o8/lane.touches/v1',
        paths: result.paths,
        packetId: result.packetId,
        laneId: result.laneId,
        lanes: result.lanes,
      }, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    if (paths.length === 0) {
      return NextResponse.json({ ok: false, note: 'Missing path or packet query.' }, { status: 400 });
    }

    const lanes = findLanesTouching(paths, { repo });
    return NextResponse.json({
      schema: 'o8/lane.touches/v1',
      paths,
      lanes,
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Lane touch lookup failed.';
    return NextResponse.json({ ok: false, note: message }, { status: 500 });
  }
}
