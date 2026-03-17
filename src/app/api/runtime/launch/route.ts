import { NextRequest, NextResponse } from 'next/server';
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
    const result = await launchRuntimeSurface({
      runtime: runtimeName,
      cwd: payload?.cwd ?? '',
      repoPath: payload?.repoPath,
      prompt: payload?.prompt ?? '',
      taskName: payload?.taskName,
      baseBranch: payload?.baseBranch,
      isolate: payload?.isolate,
      skipSetup: payload?.skipSetup,
    });

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to launch runtime session',
      },
      { status: 500 },
    );
  }
}
