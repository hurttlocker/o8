import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { cancelComposerSend, enqueueComposerSend, listQueuedComposerSends, validateComposerQueueTarget } from '@/lib/orchestrator/composer-queue';
import { COMPOSER_STEER_UNAVAILABLE_REASON, type ComposerQueueTarget } from '@/lib/orchestrator/composer-queue-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const changed = async (target: ComposerQueueTarget, id: string) => publishRealtimeMutation({ mutation: {
  mutationId: `composer-queue-${id}-${Date.now()}`, source: 'desktop', action: 'composer-queue',
  status: 'completed', surfaceId: target.threadId, repoPath: target.repoPath, createdAt: new Date().toISOString(),
} });
const failure = (error: unknown) => NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to update the queued message.' }, { status: 400 });

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  try {
    const target = validateComposerQueueTarget({ repoPath: request.nextUrl.searchParams.get('repoPath'), threadId: request.nextUrl.searchParams.get('threadId') }, false);
    return NextResponse.json({ items: listQueuedComposerSends(target) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'A queue request is required.' }, { status: 400 });
    if (body?.intent === 'steer-now') return NextResponse.json({ error: COMPOSER_STEER_UNAVAILABLE_REASON }, { status: 409 });
    const item = enqueueComposerSend(body);
    await changed(item, item.id).catch(() => {});
    return NextResponse.json({ item });
  } catch (error) { return failure(error); }
}
export async function DELETE(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  try {
    const body = await request.json();
    const target = validateComposerQueueTarget(body, false);
    if (typeof body.id !== 'string' || !cancelComposerSend(target, body.id)) return NextResponse.json({ error: 'This message is already executing or is no longer queued. Inspect the chat before stopping it.' }, { status: 409 });
    await changed(target, body.id).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (error) { return failure(error); }
}
