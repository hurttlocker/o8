export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getRecallCards } from '@/lib/cortex/client';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const query = body.query?.trim();
    const limit = body.limit ?? 5;

    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const cards = await getRecallCards(query, limit);
    return NextResponse.json({ cards, count: cards.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Recall failed' },
      { status: 500 },
    );
  }
}
