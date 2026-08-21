import { NextRequest } from 'next/server';

import { broadcastNoStore, requireBroadcastReader } from '@/lib/broadcast/route-auth';
import { buildBroadcastSnapshot } from '@/lib/broadcast/snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requireBroadcastReader(request);
  if (denied) return denied;
  const rawLimit = request.nextUrl.searchParams.get('events');
  const limit = rawLimit == null || rawLimit === '' ? 30 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return broadcastNoStore({
      schema: 'o8/broadcast.error/v1',
      ok: false,
      error: {
        code: 'invalid_snapshot_limit',
        message: 'events must be an integer from 1 through 100.',
      },
    }, 400);
  }
  try {
    return broadcastNoStore(buildBroadcastSnapshot(limit));
  } catch (error) {
    console.error('[broadcast] Snapshot projection failed:', error);
    return broadcastNoStore({
      schema: 'o8/broadcast.error/v1',
      ok: false,
      error: {
        code: 'broadcast_snapshot_unavailable',
        message: 'Broadcast snapshot is temporarily unavailable.',
      },
    }, 503);
  }
}
