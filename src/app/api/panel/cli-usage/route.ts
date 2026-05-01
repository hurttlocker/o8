import { NextResponse } from 'next/server';
import { readAllCliUsage } from '@/lib/usage/cli-scrape';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const snapshot = readAllCliUsage();
    return NextResponse.json(snapshot, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read CLI usage' },
      { status: 500 },
    );
  }
}
