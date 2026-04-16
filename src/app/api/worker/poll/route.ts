import { NextResponse } from 'next/server';
import { buildErrorPayload } from '@/lib/api/error-format';
import { getSqlite } from '@/lib/db';
import { verifyWorkerToken } from '@/lib/worker/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

interface WorkerPollRow {
  worker_run_id: string;
  event_type: string;
  payload_json: string;
}

function authErrorResponse(status: 401 | 403) {
  return NextResponse.json(
    { error: status === 401 ? 'Unauthorized' : 'Forbidden' },
    { status, headers: NO_STORE_HEADERS },
  );
}

export async function GET(request: Request) {
  try {
    const authResult = verifyWorkerToken(request.headers.get('authorization'));
    if (!authResult.ok) {
      return authErrorResponse(authResult.status);
    }

    const row = getSqlite()
      .prepare(`
        SELECT we.id, we.worker_run_id, we.event_type, we.payload_json, we.created_at
        FROM worker_events we
        JOIN worker_runs wr ON we.worker_run_id = wr.id
        WHERE wr.worker_token_id = ?
          AND wr.status = 'pending'
        ORDER BY we.created_at ASC
        LIMIT 1
      `)
      .get(authResult.workerTokenId) as WorkerPollRow | undefined;

    if (!row) {
      return NextResponse.json(
        { event: null },
        { headers: NO_STORE_HEADERS },
      );
    }

    return NextResponse.json({
      event: {
        runId: row.worker_run_id,
        type: row.event_type,
        payload: JSON.parse(row.payload_json),
      },
    }, {
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    console.error('[worker-poll] Failed to load pending worker event:', error);
    return NextResponse.json(
      buildErrorPayload('worker_poll_failed'),
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
