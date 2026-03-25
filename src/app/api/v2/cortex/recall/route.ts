import { NextResponse } from 'next/server';
import { cortexRecall } from '@/lib/cortex/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const query = typeof body?.query === 'string' ? body.query.trim() : '';

    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const recall = await cortexRecall(query, {
      limit: typeof body?.limit === 'number' ? body.limit : undefined,
      project: typeof body?.project === 'string' ? body.project : undefined,
      agent: typeof body?.agent === 'string' ? body.agent : undefined,
      channel: typeof body?.channel === 'string' ? body.channel : undefined,
      sessionKey: typeof body?.sessionKey === 'string' ? body.sessionKey : undefined,
      boostAgent: typeof body?.boostAgent === 'string' ? body.boostAgent : undefined,
      boostChannel: typeof body?.boostChannel === 'string' ? body.boostChannel : undefined,
      boostSessionKey: typeof body?.boostSessionKey === 'string' ? body.boostSessionKey : undefined,
      after: typeof body?.after === 'string' ? body.after : undefined,
      before: typeof body?.before === 'string' ? body.before : undefined,
      includeSuperseded: body?.includeSuperseded === true,
    });

    return NextResponse.json(recall);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Recall failed' },
      { status: 500 },
    );
  }
}
