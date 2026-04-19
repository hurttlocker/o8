import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getLaneEventsSince } from '@/lib/orchestrator/runtime-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 25_000;

function parseSince(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseTimeoutMs(raw: string | null): number {
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  if (parsed <= 0) return 0;
  return Math.min(MAX_TIMEOUT_MS, Math.floor(parsed));
}

function parseLaneFilter(raw: string | null): Set<string> | undefined {
  if (!raw) return undefined;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return undefined;
  return new Set(entries);
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const since = parseSince(params.get('since'));
  const timeoutMs = parseTimeoutMs(params.get('timeoutMs'));
  const laneFilter = parseLaneFilter(params.get('lanes'));

  try {
    const result = await getLaneEventsSince(since, timeoutMs, laneFilter);
    return NextResponse.json(
      { events: result.events, nextSince: result.nextSince },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read lane events.';
    console.error(`[lane-events] read failed: ${message}`);
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'lane_events_failed', message },
      },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
