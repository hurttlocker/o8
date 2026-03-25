export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cortexFeedback } from '@/lib/cortex/client';
import type { RecallFeedbackAction } from '@/lib/cortex/types';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, factId, supersededId, relatedFactId, query, reason } = body;

    if (!factId || !action) {
      return NextResponse.json({ error: 'action and factId are required' }, { status: 400 });
    }

    switch (action) {
      case 'reinforce': {
        const result = await cortexFeedback({ factId, action: 'reinforce' });
        return NextResponse.json({ ok: result.status === 'ok', action: 'reinforced', factId, result });
      }
      case 'retire': {
        const result = await cortexFeedback({ factId, action: 'retire', reason });
        return NextResponse.json({ ok: result.status === 'ok', action: 'retired', factId, result });
      }
      case 'supersede': {
        const oldFactId = typeof supersededId === 'number' ? supersededId : undefined;
        const replacementFactId = typeof relatedFactId === 'number' ? relatedFactId : factId;
        if (!oldFactId) {
          return NextResponse.json({ error: 'supersededId is required for supersede' }, { status: 400 });
        }
        const result = await cortexFeedback({
          factId: oldFactId,
          action: 'supersede',
          relatedFactId: replacementFactId,
          reason,
        });
        return NextResponse.json({
          ok: result.status === 'ok',
          action: 'resolved',
          kept: replacementFactId,
          superseded: oldFactId,
          result,
        });
      }
      case 'dismiss_for_query': {
        if (typeof query !== 'string' || !query.trim()) {
          return NextResponse.json({ error: 'query is required for dismiss_for_query' }, { status: 400 });
        }
        const result = await cortexFeedback({
          factId,
          action: action as RecallFeedbackAction,
          query,
          reason,
        });
        return NextResponse.json({ ok: result.status === 'ok', action, factId, result });
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
