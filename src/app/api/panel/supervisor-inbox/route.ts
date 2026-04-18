import { NextResponse } from 'next/server';
import { dismissInboxItem, listInboxItems } from '@/lib/supervisor/inbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const includeDismissed = searchParams.get('includeDismissed') === '1';
  const items = listInboxItems({ includeDismissed });
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : null;
  const id = typeof body?.id === 'string' ? body.id.trim() : null;

  if (action === 'dismiss' && id) {
    dismissInboxItem(id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
}
