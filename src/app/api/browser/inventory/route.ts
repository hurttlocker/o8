export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getBrowserInventorySnapshot } from '@/lib/browser/inventory';
import { performance } from 'node:perf_hooks';

export async function GET() {
  try {
    const startedAt = performance.now();
    const snapshot = await getBrowserInventorySnapshot();
    return NextResponse.json(snapshot, {
      headers: {
        'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        sourceLabel: 'Browser inventory unavailable',
        surfaces: [],
        error: error instanceof Error ? error.message : 'Unknown browser inventory error',
      },
      { status: 500 },
    );
  }
}
