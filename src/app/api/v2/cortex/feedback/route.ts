import { NextResponse } from 'next/server';
import { cortexFeedback } from '@/lib/cortex/client';
import type { RecallFeedbackAction } from '@/lib/cortex/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const factId = typeof body?.factId === 'number' ? body.factId : NaN;
    const action = typeof body?.action === 'string' ? body.action : '';

    if (!Number.isFinite(factId) || factId <= 0 || !action) {
      return NextResponse.json(
        { error: 'factId and action are required' },
        { status: 400 },
      );
    }

    const result = await cortexFeedback({
      factId,
      action: action as RecallFeedbackAction,
      relatedFactId: typeof body?.relatedFactId === 'number' ? body.relatedFactId : undefined,
      query: typeof body?.query === 'string' ? body.query : undefined,
      reason: typeof body?.reason === 'string' ? body.reason : undefined,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Feedback failed' },
      { status: 500 },
    );
  }
}
