import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { getAppUpdateState } from '@/lib/app-update/relaunch-state';
import { beginJobDrain } from '@/lib/cloud/job-queue';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const ifUpdatePending = isRecord(body) && body.ifUpdatePending === true;
  const state = getAppUpdateState();

  if (ifUpdatePending && !state.updatePending) {
    return NextResponse.json({
      ok: true,
      relaunched: false,
      skipped: true,
      reason: 'no-update-pending',
      message: 'No downloaded update is pending; restart skipped.',
      state,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  const now = new Date().toISOString();
  const cloudDrain = beginJobDrain('team_default');
  await publishRealtimeMutation({
    mutation: {
      mutationId: `app-relaunch-${randomUUID()}`,
      source: 'server',
      action: 'app-relaunch-requested',
      status: 'queued',
      createdAt: now,
      timestamp: now,
      note: ifUpdatePending
        ? `Apply pending update${state.version ? ` ${state.version}` : ''}.`
        : 'Restart requested from o8 CLI/API.',
    },
  });

  return NextResponse.json({
    ok: true,
    relaunched: true,
    skipped: false,
    message: 'Restart request published to the dashboard.',
    cloudDrain,
    state,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
