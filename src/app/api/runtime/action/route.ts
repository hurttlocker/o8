import { NextRequest, NextResponse } from 'next/server';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/openclaw';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { performRuntimeAction, type RuntimeActionRequest } from '@/lib/runtime/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as RuntimeActionRequest | null;
  const action = payload?.action;
  const surfaceId = payload?.surfaceId?.trim();

  if (!action || !surfaceId) {
    return NextResponse.json({ error: 'action and surfaceId are required' }, { status: 400 });
  }

  try {
    const clientMutationId = payload.clientMutationId?.trim() || `mutation-${Date.now()}`;
    const result = await performRuntimeAction({ ...payload, clientMutationId });
    if (result.ok) {
      invalidateCommandCenterSnapshotCaches();
      invalidateInboxCache();
    }
    await publishRealtimeMutation({
      mutation: {
        mutationId: clientMutationId,
        source: 'desktop',
        action,
        runtime: result.runtime,
        surfaceId: surfaceId,
        sessionKey: surfaceId,
        status: result.ok
          ? (result.status === 'queued' ? 'queued' : 'completed')
          : 'failed',
        note: result.note,
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
      sessionKeys: [surfaceId],
      fresh: result.ok,
    });
    return NextResponse.json(result, {
      status: result.status === 'unavailable' ? 501 : 200,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    const clientMutationId = payload?.clientMutationId?.trim() || `mutation-${Date.now()}`;
    await publishRealtimeMutation({
      mutation: {
        mutationId: clientMutationId,
        source: 'desktop',
        action: action ?? 'steer',
        surfaceId: surfaceId,
        sessionKey: surfaceId,
        status: 'failed',
        note: error instanceof Error ? error.message : 'Unable to perform runtime action',
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox'],
      fresh: true,
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to perform runtime action',
      },
      { status: 500 },
    );
  }
}
