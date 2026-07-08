import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveOpenAIKey } from '@/lib/cortex/qa/llm/byok-keys';
import { resolveRealtimeAccess } from '@/lib/voice/realtime-access';
import {
  REALTIME_MODEL,
  DEFAULT_VOICE,
  CLIENT_SECRETS_URL,
  REALTIME_TOKEN_TTL_SECONDS,
  buildClientSecretsBody,
} from '@/lib/voice/realtime-session-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Symon Realtime mode — mint an ephemeral session token (Track B, P2).
 *
 * The webview opens the WebRTC audio loop to gpt-realtime; it needs a SHORT-LIVED
 * `ek_` token, never the raw key. This server route resolves the access path
 * (src/lib/voice/realtime-access.ts) and, on the BYOK path, mints the token from
 * the user's OpenAI key via `POST /v1/realtime/client_secrets`.
 *
 *   - locked  → 403 (no key, no paid lever)
 *   - managed → 501 (paid proxy.inference lever, but the proxy isn't wired yet)
 *   - byok    → mint with the user's key (free; bills OpenAI directly)
 *
 * Gated in middleware (/api/voice/ loopback+token) AND requirePanelAuth here.
 */

// Model / voice / TTL / client-secrets URL now live in the shared session-config
// module (src/lib/voice/realtime-session-config.ts) so this desk mint, the /sdp
// relay, and the phone-hosted Agent-mode mint can never drift apart.

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const voice = typeof (body as { voice?: unknown })?.voice === 'string' ? (body as { voice: string }).voice : DEFAULT_VOICE;
  const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : REALTIME_MODEL;

  const byokKey = await resolveOpenAIKey();
  const access = await resolveRealtimeAccess(Boolean(byokKey));

  if (access.mode === 'locked') {
    return NextResponse.json({ ok: false, mode: access.mode, reason: access.reason }, { status: 403 });
  }
  if (access.mode === 'managed') {
    // Entitled, but the managed proxy isn't wired yet (MANAGED_REALTIME_READY).
    return NextResponse.json({ ok: false, mode: access.mode, reason: access.reason }, { status: 501 });
  }

  // BYOK: mint an ephemeral token with the user's key. byokKey is non-null here
  // (mode resolved to 'byok' only because resolveOpenAIKey returned a value).
  try {
    const mint = await fetch(CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${byokKey}`,
        'Content-Type': 'application/json',
      },
      // Desk mint: model + voice only. Instructions + tools + transcription are
      // applied client-side via session.update (realtime-client.ts), so this
      // stays the legacy minimal shape — identical bytes to before the refactor.
      body: JSON.stringify(buildClientSecretsBody({ model, voice }, REALTIME_TOKEN_TTL_SECONDS)),
    });

    const data = await mint.json().catch(() => null) as { value?: string; expires_at?: number; error?: { message?: string } } | null;

    if (!mint.ok || !data?.value) {
      const detail = data?.error?.message || `OpenAI returned ${mint.status}`;
      return NextResponse.json({ ok: false, mode: 'byok', reason: `Could not mint a realtime session: ${detail}` }, { status: 502 });
    }

    // The ephemeral `ek_` token + when it expires. The webview uses this for the
    // SDP exchange at /v1/realtime/calls?model=... (never the raw key).
    return NextResponse.json({ ok: true, mode: 'byok', token: data.value, expiresAt: data.expires_at ?? null, model });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'realtime session mint failed';
    return NextResponse.json({ ok: false, mode: 'byok', reason: message }, { status: 502 });
  }
}
