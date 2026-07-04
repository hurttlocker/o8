export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/orchestrator/backend-availability — mobile-safe runtime
 * availability signal. This mirrors /api/setup/orchestrator-backends without
 * requiring a bearer token, matching openclaw-availability's mobile namespace.
 *
 * Returns: { hermes: boolean }. Never throws.
 */

import { NextResponse } from 'next/server';

import { isHermesAvailable } from '@/lib/lane/orchestrator-backends/acp';

export function GET() {
  try {
    return NextResponse.json({ hermes: isHermesAvailable() }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json(
      { hermes: false, error: error instanceof Error ? error.message : String(error) },
      { status: 200, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
