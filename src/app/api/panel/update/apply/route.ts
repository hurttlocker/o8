import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { getUpdateIdleWindow, type UpdateIdleWindow } from '@/lib/app-update/idle-window';
import { getAppUpdateState } from '@/lib/app-update/relaunch-state';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: NO_STORE_HEADERS });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unavailableIdleWindow(error: unknown): UpdateIdleWindow {
  return {
    idle: false,
    active: { lanes: [], terminalSessions: [], managedRuns: [], ownedSessions: [], cloudJobs: [] },
    unavailable: [error instanceof Error ? error.message : 'idle-window'],
    checkedAt: new Date().toISOString(),
  };
}

async function readIdleWindow(): Promise<UpdateIdleWindow> {
  try {
    return await getUpdateIdleWindow();
  } catch (error) {
    return unavailableIdleWindow(error);
  }
}

export async function GET() {
  const idle = await readIdleWindow();
  return response({ ok: true, idle });
}

export async function POST(request: Request) {
  const parsed = await request.json().catch(() => null);
  if (parsed !== null && !isRecord(parsed)) {
    return response({
      ok: false,
      error: { code: 'invalid_request', message: 'Request body must be a JSON object.' },
    }, 400);
  }
  const body = parsed ?? {};
  if (body.force !== undefined && typeof body.force !== 'boolean') {
    return response({
      ok: false,
      error: { code: 'invalid_force', message: 'force must be boolean.' },
    }, 400);
  }

  const force = body.force === true;
  const state = getAppUpdateState();
  if (!state.updatePending) {
    if (state.check.outcome === 'current') {
      return response({
        ok: true,
        requested: false,
        result: { code: 'already_current' },
        message: 'The last updater check completed and this install is current.',
        state,
      });
    }
    const errorCode = state.check.errorCode ?? 'update_state_inconsistent';
    const message = state.check.outcome === 'failed'
      ? `The last updater check failed${state.check.error ? `: ${state.check.error}` : '.'}`
      : force
        ? 'Force cannot apply an update because no updater check has completed since the app server started.'
        : state.check.error ?? 'No updater check has completed since the app server started.';
    return response({
      ok: false,
      requested: false,
      error: { code: errorCode, message },
      state,
    }, 409);
  }

  const idle = await readIdleWindow();
  if (!force && !idle.idle) {
    return response({
      ok: false,
      requested: false,
      error: {
        code: 'update_apply_busy',
        message: 'Update apply refused because work is live. Retry when idle or pass force:true.',
      },
      idle,
      state,
    }, 409);
  }

  const now = new Date().toISOString();
  const published = await publishRealtimeMutation({
    mutation: {
      mutationId: `app-update-apply-${randomUUID()}`,
      source: 'server',
      action: 'app-update-apply-requested',
      status: 'queued',
      createdAt: now,
      timestamp: now,
      note: `Apply update${state.version ? ` ${state.version}` : ''}${force ? ' with force' : ''}.`,
      force,
    },
  });
  if (!published) {
    return response({
      ok: false,
      requested: false,
      error: { code: 'update_signal_unavailable', message: 'The realtime bridge could not accept the update request.' },
      idle,
      state,
    }, 503);
  }

  return response({
    ok: true,
    requested: true,
    forced: force,
    message: `Update${state.version ? ` ${state.version}` : ''} apply request sent to the app webview.`,
    idle,
    state,
  }, 202);
}
