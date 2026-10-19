import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { loadSymonTextSession } from '@/lib/mobile/symon-text-session-store';
import { resolveDeviceByToken } from '@/lib/mobile/device-registry';
import { planToken, proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { accountStateMatches, readAccountState, withAccountStateAdmission } from '@/lib/auth/account-state';
import { loadVoiceRelay, saveVoiceRelay, voiceGatewayUrl, VoiceRelayPersistenceError } from '@/lib/voice/managed-live/relay-store';
import { localVoicePreview, previewVoiceRequest } from '@/lib/voice/managed-live/local-preview';
import { personalVoiceGateway } from '@/lib/voice/managed-live/personal-dev';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function owner(request: Request): string | null {
  const principal = resolveRequestPrincipal(request);
  if (principal !== 'operator' && principal !== 'device') return null;
  const bearer = request.headers.get('authorization')?.slice(7).trim() ?? '';
  return hash(`${principal}\0${bearer}`);
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
  try {
    if (personalVoiceGateway()) return NextResponse.json({ enabled: resolveRequestPrincipal(request) === 'operator', entitled: Boolean(planToken()), transport: 'personal-webrtc' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'personal_voice_unavailable', enabled: false }, { status: 503 }); }
  const preview = localVoicePreview();
  if (preview !== 'disabled') return NextResponse.json({ enabled: preview === 'enabled', entitled: preview === 'enabled', transport: 'local-preview' }, { headers: { 'Cache-Control': 'no-store' } });
  return NextResponse.json({ enabled: process.env.O8_MANAGED_LIVE_ENABLED === '1', entitled: Boolean(planToken()) });
}
export async function POST(request: Request) {
  const principal = owner(request);
  if (!principal) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 128 * 1024) return NextResponse.json({ error: 'body_too_large' }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'invalid_body' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  let personal: string | null;
  try { personal = personalVoiceGateway(); }
  catch { if (body.action === 'start') return NextResponse.json({ error: 'personal_voice_unavailable' }, { status: 503 }); personal = null; }
  if (personal && resolveRequestPrincipal(request) !== 'operator') return NextResponse.json({ error: 'personal_voice_operator_only' }, { status: 403 });
  try {
    if (!personal && localVoicePreview() !== 'disabled' && (body.action === 'start' || !loadVoiceRelay(typeof body.id === 'string' ? body.id : ''))) {
      if (resolveRequestPrincipal(request) !== 'operator') return NextResponse.json({ error: 'local_voice_preview_operator_only' }, { status: 403 });
      return previewVoiceRequest(body, principal);
    }
  } catch { return NextResponse.json({ error: 'voice_ownership_unavailable' }, { status: 503 }); }
  try { return await withAccountStateAdmission(() => relay(body, principal, personal)); }
  catch { return NextResponse.json({ error: 'voice_account_unavailable' }, { status: 503 }); }
}
async function relay(body: Record<string, unknown>, principal: string, personal: string | null) {
  const account = readAccountState();
  if (!account || !accountStateMatches(account)) return NextResponse.json({ error: 'voice_account_unavailable' }, { status: 503 });
  const token = planToken();
  if (!token) return NextResponse.json({ error: 'managed_voice_not_entitled' }, { status: 403 });
  if (hash(token) !== account.licenseDigest) return NextResponse.json({ error: 'voice_account_unavailable' }, { status: 503 });
  const accountOwner = hash(`${principal}\0${account.generation}`);
  let gateway: string;
  let path = '/v1/live/sessions';
  let method = 'POST';
  let payload: unknown;
  try {
  if (body.action === 'start') {
    if (!personal && process.env.O8_MANAGED_LIVE_ENABLED !== '1') return NextResponse.json({ error: 'managed_voice_disabled' }, { status: 503 });
    if (typeof body.binding !== 'string' || !body.binding || body.binding.length > 2000
      || typeof body.context !== 'string' || body.context.length > 8000 || typeof body.sdp !== 'string') {
      return NextResponse.json({ error: 'invalid_binding' }, { status: 400 });
    }
    gateway = personal ?? voiceGatewayUrl(proxyBaseUrl());
    payload = { binding: hash(body.binding), context: body.context, sdp: body.sdp };
  } else {
    const id = typeof body.id === 'string' ? body.id : '';
    const record = loadVoiceRelay(id);
    if (!record || record.owner !== accountOwner || typeof body.binding !== 'string' || record.binding !== hash(body.binding)) return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
    gateway = record.gateway;
    path += `/${encodeURIComponent(id)}`;
    if (body.action === 'poll' && Number.isSafeInteger(body.after) && Number(body.after) >= 0) {
      path += `?after=${body.after}`; method = 'GET';
    } else if (body.action === 'close') method = 'DELETE';
    else if (body.action === 'event') { path += '/events'; payload = body.event; }
    else return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
  }
    const response = await fetch(`${gateway}${path}`, { method, redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(35_000) });
    const data = await response.json() as Record<string, unknown>;
    if (response.ok && body.action === 'start' && typeof data.id === 'string') {
      try { saveVoiceRelay({ version: 1, id: data.id, owner: accountOwner, binding: hash(body.binding as string), gateway, createdAt: Date.now() }); }
      catch (error) {
        if (error instanceof VoiceRelayPersistenceError && error.published) {
          // Publication proved this id was newly ours. Keep its record and an
          // unknown outcome even if best-effort closure acknowledges receipt.
          await fetch(`${gateway}/v1/live/sessions/${encodeURIComponent(data.id)}`, { method: 'DELETE', redirect: 'error',
            headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).catch(() => {});
        }
        throw error;
      }
    }
    if (readAccountState()?.generation !== account.generation || !accountStateMatches(account)) {
      return NextResponse.json({ error: 'voice_account_changed' }, { status: 503 });
    }
    return NextResponse.json(data, { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'managed_voice_transport_unknown' }, { status: 502 }); }
}
