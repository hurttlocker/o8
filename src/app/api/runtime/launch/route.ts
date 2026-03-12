import { NextRequest, NextResponse } from 'next/server';
import { launchOwnedCodexSession, type OwnedCodexLaunchRequest } from '@/lib/codex/owned';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as ({ runtime?: string } & OwnedCodexLaunchRequest) | null;
  const runtimeName = payload?.runtime?.trim();

  if (!runtimeName || runtimeName !== 'codex') {
    return NextResponse.json({ error: 'runtime=codex is required for this launch route' }, { status: 400 });
  }

  try {
    const result = await launchOwnedCodexSession({
      cwd: payload?.cwd ?? '',
      prompt: payload?.prompt ?? '',
    });

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to launch owned Codex session',
      },
      { status: 500 },
    );
  }
}
