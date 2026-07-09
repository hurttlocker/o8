import { NextResponse } from 'next/server';

import { getInstanceIdentity } from '@/lib/panel/instance-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

export function GET() {
  try {
    return NextResponse.json(getInstanceIdentity(), { headers });
  } catch (error) {
    return NextResponse.json(
      {
        product: 'o8',
        error: 'identity_unavailable',
        detail: error instanceof Error ? error.message : 'Failed to resolve identity.',
      },
      { status: 500, headers },
    );
  }
}
