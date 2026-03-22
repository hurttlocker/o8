import { NextResponse } from 'next/server';
import { checkSeedingNeeded } from '@/lib/cortex/seed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const status = await checkSeedingNeeded();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      {
        needed: true,
        currentFacts: 0,
        recommendation: error instanceof Error ? error.message : 'Unable to check seeding status',
      },
      { status: 500 },
    );
  }
}
