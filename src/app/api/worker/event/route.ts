import { NextResponse } from 'next/server';
import { buildErrorPayload } from '@/lib/api/error-format';
import { getSqlite } from '@/lib/db';
import type { PollEvent } from '@/lib/runtimes/remote';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { getLane } from '@/lib/lane/registry';
import { verifyWorkerToken } from '@/lib/worker/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };
const POLL_EVENT_TYPES = new Set<PollEvent['type']>([
  'progress',
  'branch_pushed',
  'completed',
  'errored',
]);

interface WorkerRunRow {
  worker_token_id: string;
  status: string;
  lane_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPollEventType(value: unknown): value is PollEvent['type'] {
  return typeof value === 'string' && POLL_EVENT_TYPES.has(value as PollEvent['type']);
}

function authErrorResponse(status: 401 | 403) {
  return NextResponse.json(
    { error: status === 401 ? 'Unauthorized' : 'Forbidden' },
    { status, headers: NO_STORE_HEADERS },
  );
}

function badRequest(message: string) {
  return NextResponse.json(
    { error: message },
    { status: 400, headers: NO_STORE_HEADERS },
  );
}

// #562 — Workers can POST arbitrary payload.text via /api/worker/event. That
// string must NOT be forwarded into the realtime publish, because workers are
// a lower trust boundary than the panel UI. Progress text is authoritative
// for the worker_events table (operator can read it via a read endpoint) but
// never gets broadcast. Non-progress notes are synthetic server strings and
// safe to publish.
function mutationNote(type: PollEvent['type'], payload: unknown) {
  if (type === 'progress') {
    return 'Remote worker progress update.';
  }
  if (type === 'branch_pushed' && isRecord(payload) && typeof payload.branch === 'string' && payload.branch.trim()) {
    const branch = payload.branch.trim();
    const safeBranch = /^[A-Za-z0-9._/-]{1,120}$/.test(branch) ? branch : 'remote branch';
    return `Remote branch pushed: ${safeBranch}`;
  }
  if (type === 'completed') {
    return 'Remote worker completed the run.';
  }
  if (type === 'errored') {
    return 'Remote worker reported an error.';
  }
  return `Remote worker reported ${type}.`;
}

export async function POST(request: Request) {
  try {
    const authResult = verifyWorkerToken(request.headers.get('authorization'));
    if (!authResult.ok) {
      return authErrorResponse(authResult.status);
    }

    const body = await request.json().catch(() => null);
    if (!isRecord(body)) {
      return badRequest('Invalid request body');
    }

    const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
    const type = body.type;
    const payload = body.payload;

    if (!runId || !isPollEventType(type) || !('payload' in body)) {
      return badRequest('Invalid worker event payload');
    }

    const now = new Date().toISOString();
    const payloadJson = JSON.stringify(payload);
    const sqlite = getSqlite();
    const tx = sqlite.transaction(() => {
      const run = sqlite
        .prepare(`
          SELECT worker_token_id, status, lane_id
          FROM worker_runs
          WHERE id = ?
          LIMIT 1
        `)
        .get(runId) as WorkerRunRow | undefined;

      if (!run || run.worker_token_id !== authResult.workerTokenId) {
        return { ok: false as const };
      }

      sqlite
        .prepare(`
          INSERT INTO worker_events (worker_run_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(runId, type, payloadJson, now);

      // #561 — Guard status transitions against out-of-order events. Terminal
      // statuses (completed/errored/cancelled) are immutable — a late
      // branch_pushed after a completed event must not regress status.
      // progress already had this guard; extend to branch_pushed/completed/errored.
      if (type === 'progress') {
        sqlite
          .prepare(`
            UPDATE worker_runs
            SET status = CASE WHEN status = 'pending' THEN 'running' ELSE status END,
                last_event_at = ?
            WHERE id = ?
          `)
          .run(now, runId);
      } else if (type === 'branch_pushed') {
        const remoteBranch = isRecord(payload) && typeof payload.branch === 'string'
          ? payload.branch.trim() || null
          : null;
        sqlite
          .prepare(`
            UPDATE worker_runs
            SET status = 'pushed',
                remote_branch = ?,
                last_event_at = ?
            WHERE id = ?
              AND status NOT IN ('completed', 'errored', 'cancelled')
          `)
          .run(remoteBranch, now, runId);
      } else if (type === 'completed') {
        sqlite
          .prepare(`
            UPDATE worker_runs
            SET status = 'completed',
                completed_at = ?,
                last_event_at = ?
            WHERE id = ?
              AND status NOT IN ('completed', 'errored', 'cancelled')
          `)
          .run(now, now, runId);
      } else {
        sqlite
          .prepare(`
            UPDATE worker_runs
            SET status = 'errored',
                completed_at = ?,
                last_event_at = ?,
                error_json = ?
            WHERE id = ?
              AND status NOT IN ('completed', 'errored', 'cancelled')
          `)
          .run(now, now, payloadJson, runId);
      }

      return { ok: true as const, laneId: run.lane_id };
    });

    const writeResult = tx();
    if (!writeResult.ok) {
      return authErrorResponse(403);
    }

    const lane = getLane(writeResult.laneId);
    try {
      await publishRealtimeMutation({
        mutation: {
          mutationId: `worker-event-${runId}-${type}-${Date.now()}`,
          source: 'server',
          action: 'worker-event',
          status: 'completed',
          runtime: lane?.runtime,
          surfaceId: lane?.sessionKey ?? undefined,
          sessionKey: lane?.sessionKey ?? undefined,
          laneId: lane?.id ?? writeResult.laneId,
          packetId: lane?.packetId ?? undefined,
          repoPath: lane?.repoPath,
          branch: lane?.branch,
          note: mutationNote(type, payload),
          createdAt: now,
          settledAt: now,
        },
        refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
        sessionKeys: lane?.sessionKey ? [lane.sessionKey] : [],
        fresh: true,
      });
    } catch (error) {
      console.error('[worker-event] Failed to publish realtime mutation:', error);
    }

    return NextResponse.json(
      { ok: true },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error('[worker-event] Failed to record worker event:', error);
    return NextResponse.json(
      buildErrorPayload('worker_event_failed'),
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
