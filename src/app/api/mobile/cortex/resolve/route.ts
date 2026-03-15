import { NextResponse } from 'next/server';
import { cortexReinforce, cortexRetire, cortexSupersede } from '@/lib/cortex/client';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, factId, supersededId } = body;

    if (!factId || !action) {
      return NextResponse.json({ error: 'action and factId are required' }, { status: 400 });
    }

    switch (action) {
      case 'reinforce': {
        const ok = await cortexReinforce(factId);
        return NextResponse.json({ ok, action: 'reinforced', factId });
      }
      case 'retire': {
        const ok = await cortexRetire(factId);
        return NextResponse.json({ ok, action: 'retired', factId });
      }
      case 'supersede': {
        if (!supersededId) {
          return NextResponse.json({ error: 'supersededId is required for supersede' }, { status: 400 });
        }
        const [okSupersede, okReinforce] = await Promise.all([
          cortexSupersede(supersededId),
          cortexReinforce(factId),
        ]);
        return NextResponse.json({
          ok: okSupersede && okReinforce,
          action: 'resolved',
          kept: factId,
          superseded: supersededId,
        });
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Resolve failed' },
      { status: 500 },
    );
  }
}
