import { NextResponse } from 'next/server';
import { collectResourceUsage } from '@/lib/lane/resource-attribution';

export const dynamic = 'force-dynamic';

/**
 * GET /api/panel/resource-usage
 *
 * Live per-session CPU/RAM attribution for the Resources panel. Gated by the
 * global middleware under `/api/panel/*` (loopback + ws-token) — no auth code
 * needed here. Never throws; returns a structured error payload on failure.
 */
export async function GET() {
  try {
    const result = await collectResourceUsage();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({
      sessions: [],
      processes: [],
      total: { cpuPercent: 0, memBytes: 0, ramTotalBytes: 0 },
      error: error instanceof Error ? error.message : 'Failed to collect resource usage.',
    });
  }
}
