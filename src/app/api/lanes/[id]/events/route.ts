import { NextResponse, type NextRequest } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import {
  isAgentReportReason,
  normalizeAgentReportEvent,
  normalizeAgentReportMessage,
  normalizeAgentReportMetadata,
  reportAgentEvent,
} from '@/lib/lane/agent-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function requireLoopbackBearer(req: NextRequest): NextResponse | null {
  if (!LOOPBACK_HOSTS.has(req.nextUrl.hostname)) {
    return NextResponse.json({ ok: false, note: 'Lane event reports must come from loopback.' }, { status: 403 });
  }

  const expected = getOrCreateWsToken().trim();
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!expected || token !== expected) {
    return NextResponse.json({ ok: false, note: 'Unauthorized.' }, { status: 401 });
  }

  return null;
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

  return NextResponse.json({
    ok: true,
    lane: result.lane,
    event: result.event,
    statusChanged: result.statusChanged,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
