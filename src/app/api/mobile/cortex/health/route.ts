import { NextResponse } from 'next/server';
import { getHealthSummary } from '@/lib/cortex/client';

export async function GET() {
  try {
    const summary = await getHealthSummary();
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { available: false, error: err instanceof Error ? err.message : 'Health check failed' },
      { status: 500 },
    );
  }
}
