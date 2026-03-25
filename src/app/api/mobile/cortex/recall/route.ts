export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cortexRecall } from '@/lib/cortex/client';

// Thin API wrapper over the shared Cortex recall client.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const query = body.query?.trim();
    const limit = body.limit ?? 5;

    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const recall = await cortexRecall(query, { limit });
    const cards = recall.items;
    return NextResponse.json({
      cards,
      count: cards.length,
      diagnostics: recall.diagnostics,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Recall failed' },
      { status: 500 },
    );
  }
}
