import { NextRequest, NextResponse } from 'next/server';
import { readVisualQueueReceipt } from '@/lib/composer/visual-queue-receipt';
import { requirePanelAuth } from '@/lib/panel/auth';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { cancelComposerSend, enqueueComposerSend, listComposerTranscriptSends, promoteComposerSend, validateComposerQueueTarget } from '@/lib/orchestrator/composer-queue';
import type { ComposerQueueTarget } from '@/lib/orchestrator/composer-queue-types';
import { getOrchestratorBackend } from '@/lib/lane/orchestrator-backends/registry';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';

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
    const id = request.nextUrl.searchParams.get('id');
    if (id !== null) {
      const receipt = readVisualQueueReceipt(target, id);
      return receipt ? NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store' } }) : NextResponse.json({ error: 'This visual request was not found in this chat.' }, { status: 404 });
    }
    const backend = request.nextUrl.searchParams.get('backend');
    const canSteer = (id: unknown) => isOrchestratorBackendId(id) && Boolean(getOrchestratorBackend(id).liveSteer);
    const items = listComposerTranscriptSends(target);
    const steerableIds = items.filter(item => canSteer(item.payload.routing.collide && item.payload.routing.mode !== 'single' ? 'collide' : item.payload.routing.backend)).map(item => item.id);
    return NextResponse.json({ items, canSteer: canSteer(backend), steerableIds }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'A queue request is required.' }, { status: 400 });
    const item = enqueueComposerSend(body);
    await changed(item, item.id).catch(() => {});
    return NextResponse.json({ item });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  try {
    const body = await request.json();
    const target = validateComposerQueueTarget(body);
    if (typeof body.id !== 'string') throw new Error('A queued message identity is required.');
    const item = promoteComposerSend(target, body.id);
    await changed(target, item.id).catch(() => {});
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
