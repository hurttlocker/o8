import { NextResponse } from 'next/server';
import { serverTimingHeaders } from '@/lib/performance/server-timing';
import { bulkDismissInboxItems, dismissInboxItem, escalateInboxItem, listInboxItems, summarizeInboxItems } from '@/lib/supervisor/inbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const startedAt = performance.now();
  const { searchParams } = new URL(request.url);
  const includeDismissed = searchParams.get('includeDismissed') === '1';
  const includeAllProjects = searchParams.get('scope') === 'all';
  const projectId = searchParams.get('projectId');
  const items = listInboxItems({ includeDismissed, includeAllProjects, projectId });
  return NextResponse.json(
    { items, summary: summarizeInboxItems(items) },
    { headers: serverTimingHeaders(startedAt) },
  );
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : null;
  const id = typeof body?.id === 'string' ? body.id.trim() : null;

  if (action === 'dismiss' && id) {
    dismissInboxItem(id);
    return NextResponse.json({ ok: true });
  }
  if (action === 'escalate' && id) {
    // Handed to the orchestrator via "Add to orchestrator chat" — heal-bot
    // auto-resolves once the faulting packet's lane merges.
    escalateInboxItem(id);
    return NextResponse.json({ ok: true });
  }
  if (action === 'clear') {
    return NextResponse.json({ ok: true, dismissed: bulkDismissInboxItems() });
  }

  return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
}
