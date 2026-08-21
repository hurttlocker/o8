import { NextRequest } from 'next/server';

import { BroadcastQueryError, listBroadcastEvents } from '@/lib/broadcast/events';
import { broadcastNoStore, requireBroadcastReader } from '@/lib/broadcast/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function limitParam(value: string | null): number {
  if (!value) return 50;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('limit must be an integer from 1 through 100.');
  }
  return parsed;
}

export function GET(request: NextRequest) {
  const denied = requireBroadcastReader(request);
  if (denied) return denied;
  try {
    const page = listBroadcastEvents({
      cursor: request.nextUrl.searchParams.get('since'),
      limit: limitParam(request.nextUrl.searchParams.get('limit')),
      kinds: ['commentary'],
    });
    return broadcastNoStore({
      schema: 'o8/broadcast.commentary/v1',
      commentary: page.events.map((event) => ({
        id: event.id,
        actor: event.actor,
        text: event.detail ?? '',
        timestamp: event.timestamp,
      })),
      cursor: page.cursor,
      hasMore: page.hasMore,
    });
  } catch (error) {
    const invalid = error instanceof BroadcastQueryError
      || (error instanceof Error && error.message.startsWith('limit must'));
    return broadcastNoStore({
      schema: 'o8/broadcast.commentary.error/v1',
      ok: false,
      error: {
        code: invalid ? 'invalid_broadcast_commentary_query' : 'broadcast_commentary_unavailable',
        message: invalid && error instanceof Error
          ? error.message
          : 'Broadcast commentary is temporarily unavailable.',
      },
    }, invalid ? 400 : 503);
  }
}
