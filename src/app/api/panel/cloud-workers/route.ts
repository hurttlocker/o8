/**
 * Panel-side surface for cloud workers (issue #514 v0 scaffolding).
 *
 * Auth: this route is UI-facing, so it rides the panel middleware gate
 * (loopback + ws-token). Individual cloud workers authenticate against
 * /api/cloud/* with their own service-account keys — that's a separate
 * credential tier.
 *
 * GET  → list current cloud-worker keys + connection summary
 * POST → { action: 'create_key', teamId, label } or { action: 'revoke_key', id }
 */
import { NextResponse } from 'next/server';
import {
  createCloudWorkerKey,
  listCloudWorkerKeys,
  revokeCloudWorkerKey,
} from '@/lib/cloud/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: NO_STORE_HEADERS });
}

function toPublicShape(record: ReturnType<typeof listCloudWorkerKeys>[number]) {
  return {
    id: record.id,
    teamId: record.teamId,
    label: record.label,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt ?? null,
  };
}

export async function GET() {
  try {
    const keys = listCloudWorkerKeys().map(toPublicShape);
    return response({
      keys,
      // Worker connection discovery lands in a follow-up — for v0 we don't
      // surface live poll state yet because there is no worker CLI to connect.
      connectedWorkers: [],
    });
  } catch (error) {
    console.error('[panel-cloud-workers] failed to list keys:', error);
    return response({ error: 'Failed to load cloud worker keys.' }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || typeof body.action !== 'string') {
      return response({ error: 'Invalid request body.' }, 400);
    }

    if (body.action === 'create_key') {
      const teamId = typeof body.teamId === 'string' && body.teamId.trim()
        ? body.teamId.trim()
        : 'team_default';
      const label = typeof body.label === 'string' && body.label.trim()
        ? body.label.trim()
        : 'Unnamed worker pool';
      const { record, plaintext } = createCloudWorkerKey({ teamId, label });
      return response({
        id: record.id,
        plaintextKey: plaintext,
        record: toPublicShape(record),
      }, 201);
    }

    if (body.action === 'revoke_key') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) {
        return response({ error: 'id is required' }, 400);
      }
      const revoked = revokeCloudWorkerKey(id);
      if (!revoked) {
        return response({ error: 'Key not found' }, 404);
      }
      return response({ record: toPublicShape(revoked) });
    }

    return response({ error: `Unknown action: ${body.action}` }, 400);
  } catch (error) {
    console.error('[panel-cloud-workers] action failed:', error);
    return response({ error: 'Cloud worker action failed.' }, 500);
  }
}
