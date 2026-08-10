import { NextRequest, NextResponse } from 'next/server';
import '@/lib/runtimes'; // Ensure runtimes are registered
import { getRuntime } from '@/lib/runtimes/registry';
import { runtimeIdFromSessionKey } from '@/lib/runtime/transcript';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim();
  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400 });
  }

  const runtimeId = runtimeIdFromSessionKey(sessionKey);
  if (!runtimeId) {
    return NextResponse.json({ error: `Cannot determine runtime for session: ${sessionKey}` }, { status: 400 });
  }

  const adapter = getRuntime(runtimeId);
  if (!adapter?.capabilities.costTelemetry || !adapter.getTelemetry) {
    return NextResponse.json({ error: `Runtime ${runtimeId} does not support telemetry` }, { status: 400 });
  }

  try {
    const telemetry = await adapter.getTelemetry(sessionKey);
    if (!telemetry) {
      return NextResponse.json({ error: `No telemetry available for session: ${sessionKey}` }, { status: 404 });
    }

    return NextResponse.json({ telemetry }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load runtime telemetry' },
      { status: 500 },
    );
  }
}
