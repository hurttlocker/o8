import { NextRequest, NextResponse } from 'next/server';
import { performRuntimeAction, type RuntimeActionRequest } from '@/lib/runtime/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as RuntimeActionRequest | null;
  const action = payload?.action;
  const surfaceId = payload?.surfaceId?.trim();

  if (!action || !surfaceId) {
    return NextResponse.json({ error: 'action and surfaceId are required' }, { status: 400 });
  }

  try {
    const result = await performRuntimeAction(payload);
    return NextResponse.json(result, {
      status: result.status === 'unavailable' ? 501 : 200,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to perform runtime action',
      },
      { status: 500 },
    );
  }
}
