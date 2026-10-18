import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { loadSymonTextSession } from '@/lib/mobile/symon-text-session-store';
import { resolveDeviceByToken } from '@/lib/mobile/device-registry';
import { planToken, proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const sessions = new Map<string, { owner: string; binding: string; until: number }>();
function owner(request: Request): string | null {
  const principal = resolveRequestPrincipal(request);
  if (principal !== 'operator' && principal !== 'device') return null;
  return createHash('sha256').update(request.headers.get('authorization') ?? '').digest('hex');
}
export async function GET(request: Request) {
  if (!owner(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sessionId = new URL(request.url).searchParams.get('symonSession');
  if (sessionId) {
    const session = loadSymonTextSession(sessionId);
    const role = resolveRequestPrincipal(request);
    const device = role === 'device' ? resolveDeviceByToken(request.headers.get('authorization')?.slice(7) ?? '') : null;
    const ready = Boolean(session && session.subject === role && (role === 'operator' || session.deviceId === device?.id));
    return NextResponse.json({ ready, ...(ready && session ? { session: { sessionId: session.sessionId, engine: session.engine, model: session.model, transcript: session.transcript } } : {}) }, { status: ready ? 200 : 409 });
  }
  return NextResponse.json({ enabled: process.env.O8_MANAGED_LIVE_ENABLED === '1', entitled: Boolean(planToken()) });
}
export async function POST(request: Request) {
  const principal = owner(request);
  if (!principal) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const token = planToken();
  if (!token) return NextResponse.json({ error: 'managed_voice_not_entitled' }, { status: 403 });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 128 * 1024) return NextResponse.json({ error: 'body_too_large' }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'invalid_body' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const now = Date.now();
  for (const [id, record] of sessions) if (record.until < now) sessions.delete(id);
  let path = '/v1/live/sessions';
  let method = 'POST';
  let payload: unknown;
  if (body.action === 'start') {
    if (process.env.O8_MANAGED_LIVE_ENABLED !== '1') return NextResponse.json({ error: 'managed_voice_disabled' }, { status: 503 });
    if (typeof body.binding !== 'string' || !body.binding || body.binding.length > 2000
      || typeof body.context !== 'string' || body.context.length > 8000 || typeof body.sdp !== 'string') {
      return NextResponse.json({ error: 'invalid_binding' }, { status: 400 });
    }
    payload = { binding: createHash('sha256').update(body.binding).digest('hex'), context: body.context, sdp: body.sdp };
  } else {
    const id = typeof body.id === 'string' ? body.id : '';
    const record = sessions.get(id);
    if (!record || record.owner !== principal || record.binding !== body.binding) return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
    path += `/${encodeURIComponent(id)}`;
    if (body.action === 'poll' && Number.isSafeInteger(body.after) && Number(body.after) >= 0) {
      path += `?after=${body.after}`; method = 'GET';
    } else if (body.action === 'close') method = 'DELETE';
    else if (body.action === 'event') { path += '/events'; payload = body.event; }
    else return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
  }
  try {
    const response = await fetch(`${proxyBaseUrl()}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(35_000) });
    const data = await response.json() as Record<string, unknown>;
    if (response.ok && body.action === 'start' && typeof data.id === 'string') {
      sessions.set(data.id, { owner: principal, binding: body.binding as string, until: now + 3 * 60 * 60_000 });
    }
    return NextResponse.json(data, { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'managed_voice_transport_unknown' }, { status: 502 }); }
}
