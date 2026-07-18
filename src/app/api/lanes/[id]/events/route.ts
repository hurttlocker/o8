import { NextResponse, type NextRequest } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { isLocalWorkerToken } from '@/lib/auth/worker-token';
import {
  isAgentReportReason,
  isPacketAgentReportEvent,
  normalizeAgentReportEvent,
  normalizeAgentReportMessage,
  normalizeAgentReportMetadata,
  reportAgentEvent,
} from '@/lib/lane/agent-report';
import { getPacketTailBatch, resolvePacketTailPacketId } from '@/lib/lane/packet-tail';
import { checkSessionBindingFault } from '@/lib/lane/session-binding-fault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function requireLoopbackBearer(req: NextRequest): NextResponse | null {
  // Mirror the global middleware's loopback detection (isTrustedLocalRequest):
  // accept the Host header hostname too, not just req.nextUrl.hostname. A
  // dispatched agent's CLI request reaches the bundled server with a loopback
  // Host header but, depending on how the server is bound/proxied, nextUrl can
  // resolve to a non-loopback hostname — which previously 403'd valid agent
  // `o8 packet report` calls even though the middleware (which gates /api/lanes)
  // already accepted them. (#1147 dogfood finding.)
  const hostHeader = req.headers.get('host')?.split(':')[0]?.trim();
  const isLoopback = LOOPBACK_HOSTS.has(req.nextUrl.hostname)
    || (!!hostHeader && LOOPBACK_HOSTS.has(hostHeader));
  if (!isLoopback) {
    return NextResponse.json({ ok: false, note: 'Lane event reports must come from loopback.' }, { status: 403 });
  }

  const expected = getOrCreateWsToken().trim();
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  // Dispatched workers present O8_WORKER_TOKEN, never the operator ws-token
  // (SECURITY_AUDIT_2026-07-02 §CRIT-1) — reporting on a lane is exactly the
  // worker credential's intended scope, so accept it alongside the ws-token.
  if (!expected || (token !== expected && !isLocalWorkerToken(token))) {
    return NextResponse.json({ ok: false, note: 'Unauthorized.' }, { status: 401 });
  }

  return null;
}

function parseSince(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseLimit(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseTimeoutMs(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function parseFollow(raw: string | null): boolean {
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requireLoopbackBearer(req);
  if (denied) return denied;

  const { id } = await params;
  const packetId = resolvePacketTailPacketId(id);
  if (!packetId) {
    return NextResponse.json({ ok: false, note: 'packetId or lane id is required.' }, { status: 400 });
  }

  const query = req.nextUrl.searchParams;
  const follow = parseFollow(query.get('follow'));
  const since = parseSince(query.get('since'));
  const timeoutMs = follow ? parseTimeoutMs(query.get('timeoutMs')) ?? 25_000 : 0;

  try {
    const result = await getPacketTailBatch({
      packetId,
      since,
      timeoutMs,
      limit: parseLimit(query.get('limit')),
    });
    return NextResponse.json({
      schema: 'o8/packet.tail.batch/v1',
      packetId,
      events: result.events,
      nextSince: result.nextSince,
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read packet events.';
    console.error(`[packet-tail] read failed: ${message}`);
    return NextResponse.json(
      { ok: false, error: { code: 'packet_tail_failed', message } },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requireLoopbackBearer(req);
  if (denied) return denied;

  const { id } = await params;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.verb !== 'agent_report') {
    return NextResponse.json({ ok: false, note: 'Only agent_report events are accepted.' }, { status: 400 });
  }

  const event = normalizeAgentReportEvent(body.event);
  if (!event) {
    return NextResponse.json({ ok: false, note: 'Missing report event.' }, { status: 400 });
  }
  if (!isPacketAgentReportEvent(event)) {
    return NextResponse.json({ ok: false, note: 'Invalid packet report event.' }, { status: 400 });
  }

  const reason = body.reason === undefined || body.reason === null || body.reason === ''
    ? undefined
    : body.reason;
  if (reason !== undefined && !isAgentReportReason(reason)) {
    return NextResponse.json({ ok: false, note: 'Invalid agent report reason.' }, { status: 400 });
  }

  const metadata = body.metadata === undefined || body.metadata === null
    ? undefined
    : normalizeAgentReportMetadata(body.metadata);
  if (body.metadata !== undefined && body.metadata !== null && !metadata) {
    return NextResponse.json({ ok: false, note: 'metadata must be a JSON object.' }, { status: 400 });
  }

  const result = reportAgentEvent({
    laneId: id,
    event,
    reason,
    message: normalizeAgentReportMessage(body.message),
    metadata,
  });
  if (!result) {
    return NextResponse.json({ ok: false, note: 'Lane not found.' }, { status: 404 });
  }

  // #1502 — a worker posting ANY report is alive; if its lane has no session
  // binding it has no transcript and will misfire the silent-exit detector on
  // completion. The detector self-guards on active status + null sessionKey.
  checkSessionBindingFault(id);

  return NextResponse.json({
    ok: true,
    lane: result.lane,
    event: result.event,
    statusChanged: result.statusChanged,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
