import { NextResponse } from 'next/server';
import { getRuntime } from '@/lib/runtimes';
import { getRemoteRuntimeFlag, setRemoteRuntimeFlag } from '@/lib/worker/feature-flags';
import { createToken, getFleetStatus, listTokens, revokeToken } from '@/lib/worker/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed));
    }
  }
  return undefined;
}

async function buildWorkersResponse() {
  return {
    tokens: listTokens(),
    fleet: getFleetStatus(),
    remoteFlag: await getRemoteRuntimeFlag(),
    remoteRuntimeRegistered: Boolean(getRuntime('remote-customer')),
  };
}

export async function GET() {
  try {
    return response(await buildWorkersResponse());
  } catch (error) {
    console.error('[panel-workers] Failed to load workers data:', error);
    return response({ error: 'Failed to load workers settings.' }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || typeof body.action !== 'string') {
      return response({ error: 'Invalid request body.' }, 400);
    }

    if (body.action === 'create_token') {
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if (!label) {
        return response({ error: 'Token label is required.' }, 400);
      }

      return response(createToken({
        label,
        scope: typeof body.scope === 'string' ? body.scope.trim() : undefined,
        maxWorkers: parsePositiveInteger(body.maxWorkers),
      }), 201);
    }

    if (body.action === 'revoke_token') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) {
        return response({ error: 'Token id is required.' }, 400);
      }

      if (!revokeToken(id)) {
        return response({ error: 'Token not found.' }, 404);
      }

      return response({ ok: true });
    }

    if (body.action === 'set_remote_flag') {
      if (typeof body.enabled !== 'boolean') {
        return response({ error: 'enabled must be a boolean.' }, 400);
      }

      await setRemoteRuntimeFlag(body.enabled);
      return response({
        ok: true,
        ...await buildWorkersResponse(),
      });
    }

    return response({ error: 'Unknown action.' }, 400);
  } catch (error) {
    console.error('[panel-workers] Failed to update workers data:', error);
    return response({ error: 'Failed to update workers settings.' }, 500);
  }
}
