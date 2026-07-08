import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveOpenAIKey } from '@/lib/cortex/qa/llm/byok-keys';
import { resolveRealtimeAccess } from '@/lib/voice/realtime-access';
import {
  REALTIME_MODEL,
  DEFAULT_VOICE,
  CLIENT_SECRETS_URL,
  REALTIME_CALLS_URL,
  REALTIME_TOKEN_TTL_SECONDS,
  buildClientSecretsBody,
} from '@/lib/voice/realtime-session-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Symon Realtime mode — WebRTC SDP signaling proxy (Track B, P3).
 *
 * The browser owns the RTCPeerConnection (mic in / audio out flow directly
 * browser↔OpenAI), but we proxy the SDP offer/answer handshake server-side so
 * the webview never fetches api.openai.com directly — no CORS/CSP surprise, and
 * the OpenAI key never reaches the browser. Flow:
 *   browser createOffer → POST {sdp} here → we mint an ephemeral token + POST the
 *   offer to /v1/realtime/calls → return the answer SDP → browser setRemoteDescription.
 *
 * Access gating mirrors /session (byok mints / managed 501 / locked 403). Gated
 * in middleware (/api/voice/) + requirePanelAuth.
 */

// Model / voice / URLs / TTL come from the shared session-config module so this
// relay stays in lockstep with the desk mint and the Agent-mode mint.

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({})) as { sdp?: unknown; model?: unknown; voice?: unknown };
  const offerSdp = typeof body?.sdp === 'string' ? body.sdp : '';
  if (!offerSdp.trim()) {
    return NextResponse.json({ ok: false, reason: 'sdp (offer) is required.' }, { status: 400 });
  }
  const model = typeof body?.model === 'string' ? body.model : REALTIME_MODEL;
  const voice = typeof body?.voice === 'string' ? body.voice : DEFAULT_VOICE;

  const byokKey = await resolveOpenAIKey();
  const access = await resolveRealtimeAccess(Boolean(byokKey));
  if (access.mode === 'locked') return NextResponse.json({ ok: false, mode: access.mode, reason: access.reason }, { status: 403 });
  if (access.mode === 'managed') return NextResponse.json({ ok: false, mode: access.mode, reason: access.reason }, { status: 501 });

  try {
    // 1. Mint a short-lived ephemeral token (never hand the raw key to the SDP call path).
    const mint = await fetch(CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${byokKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildClientSecretsBody({ model, voice }, REALTIME_TOKEN_TTL_SECONDS)),
    });
    const mintData = await mint.json().catch(() => null) as { value?: string; error?: { message?: string } } | null;
    if (!mint.ok || !mintData?.value) {
      const detail = mintData?.error?.message || `OpenAI returned ${mint.status}`;
      return NextResponse.json({ ok: false, mode: 'byok', reason: `Could not mint a realtime session: ${detail}` }, { status: 502 });
    }

    // 2. Exchange the browser's offer SDP for OpenAI's answer SDP (raw SDP, not JSON).
    const call = await fetch(`${REALTIME_CALLS_URL}?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mintData.value}`, 'Content-Type': 'application/sdp' },
      body: offerSdp,
    });
    const answerSdp = await call.text();
    if (!call.ok || !answerSdp.includes('v=')) {
      return NextResponse.json({ ok: false, mode: 'byok', reason: `SDP exchange failed: ${answerSdp.slice(0, 200) || call.status}` }, { status: 502 });
    }

    return NextResponse.json({ ok: true, mode: 'byok', model, sdp: answerSdp });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'realtime SDP exchange failed';
    return NextResponse.json({ ok: false, mode: 'byok', reason: message }, { status: 502 });
  }
}
