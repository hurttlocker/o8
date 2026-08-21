import { NextRequest } from 'next/server';

import { BroadcastQueryError, listBroadcastEvents } from '@/lib/broadcast/events';
import { broadcastNoStore, requireBroadcastReader } from '@/lib/broadcast/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_WAIT_MS = 25_000;
const POLL_INTERVAL_MS = 250;

function integerParam(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function requestedKinds(request: NextRequest): string[] | null {
  const values = request.nextUrl.searchParams.getAll('kinds')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length ? values : null;
}

function waitBriefly(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

export async function GET(request: NextRequest) {
  const denied = requireBroadcastReader(request);
  if (denied) return denied;
  try {
    const params = request.nextUrl.searchParams;
    const waitMs = integerParam(params.get('wait'), 0, 0, MAX_WAIT_MS);
    const options = {
      cursor: params.get('cursor'),
      limit: integerParam(params.get('limit'), 50, 1, 100),
      repo: params.get('repo'),
      lane: params.get('lane'),
      kinds: requestedKinds(request),
    };
    const deadline = Date.now() + waitMs;
    for (;;) {
      const page = listBroadcastEvents(options);
      if (page.events.length > 0 || waitMs === 0 || Date.now() >= deadline) {
        return broadcastNoStore(page);
      }
      options.cursor = page.cursor;
      await waitBriefly();
    }
  } catch (error) {
    if (!(error instanceof BroadcastQueryError) && !(
      error instanceof Error && error.message.startsWith('Expected an integer')
    )) {
      console.error('[broadcast] Event projection failed:', error);
      return broadcastNoStore({
        schema: 'o8/broadcast.error/v1',
        ok: false,
        error: {
          code: 'broadcast_events_unavailable',
          message: 'Broadcast events are temporarily unavailable.',
        },
      }, 503);
    }
    return broadcastNoStore({
      schema: 'o8/broadcast.error/v1',
      ok: false,
      error: {
        code: 'invalid_broadcast_query',
        message: error instanceof Error ? error.message : 'Broadcast query is invalid.',
      },
    }, 400);
  }
}
