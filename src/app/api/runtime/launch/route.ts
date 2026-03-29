import { NextRequest, NextResponse } from 'next/server';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/openclaw';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { launchRuntimeSurface, type RuntimeLaunchRequest } from '@/lib/runtime/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as RuntimeLaunchRequest | null;
  const runtimeName = payload?.runtime?.trim();

  if (!runtimeName) {
    return NextResponse.json({ error: 'runtime is required for this launch route' }, { status: 400 });
  }

  try {
    const clientMutationId = payload?.clientMutationId?.trim() || `mutation-${Date.now()}`;
    const result = await launchRuntimeSurface({
      runtime: runtimeName,
      clientMutationId,
      cwd: payload?.cwd ?? '',
      repoPath: payload?.repoPath,
      prompt: payload?.prompt ?? '',
      taskName: payload?.taskName,
      baseBranch: payload?.baseBranch,
      isolate: payload?.isolate ?? (payload?.isolation === 'branch' ? true : payload?.isolation === 'main' ? false : undefined),
      skipSetup: payload?.skipSetup,
    });

    if (result.ok) {
      invalidateCommandCenterSnapshotCaches();
      invalidateInboxCache();
    }
    await publishRealtimeMutation({
      mutation: {
        mutationId: clientMutationId,
        source: 'desktop',
        action: 'launch',
        runtime: result.runtime,
        surfaceId: result.surfaceId,
        sessionKey: result.surfaceId,
        status: result.ok ? 'queued' : 'failed',
        note: result.note,
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
      sessionKeys: result.surfaceId ? [result.surfaceId] : [],
      fresh: true,
    });

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    console.error('[runtime-launch]', runtimeName, error instanceof Error ? error.message : error);
    const clientMutationId = payload?.clientMutationId?.trim() || `mutation-${Date.now()}`;
    invalidateCommandCenterSnapshotCaches();
    invalidateInboxCache();
    await publishRealtimeMutation({
      mutation: {
        mutationId: clientMutationId,
        source: 'desktop',
        action: 'launch',
        runtime: runtimeName ?? 'unknown',
        surfaceId: payload?.cwd?.trim() || payload?.repoPath?.trim(),
        sessionKey: payload?.cwd?.trim() || payload?.repoPath?.trim(),
        status: 'failed',
        note: error instanceof Error ? error.message : 'Unable to launch runtime session',
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox'],
      fresh: true,
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to launch runtime session',
      },
      { status: 500 },
    );
  }
}
