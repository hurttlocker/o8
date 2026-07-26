import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { pollFleetNarration, voiceNarrationEnabled } from '@/lib/voice/fleet-narration-bridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Fleet narration long-poll (#1616 — voice slice).
 *
 * The voice client polls this to learn WHAT to speak: it taps the live
 * lane-lifecycle bus from a `since` cursor and returns budget-aware
 * `NarrationDecision`s (blocking transitions → `interrupt-now`, FYIs held,
 * chatter suppressed). The realtime model only voices `spoken`; it makes no
 * governance decision here.
 *
 * Dormant by default — returns `{ ok: true, enabled: false }` until
 * `O8_VOICE_NARRATION` is set, so the client can poll unconditionally. Gated in
 * middleware (`/api/voice/`, default-deny) + `requirePanelAuth`.
 */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  if (!voiceNarrationEnabled()) {
    return NextResponse.json({ ok: true, enabled: false, decisions: [], spoken: [], nextSince: 0 });
  }

  const params = request.nextUrl.searchParams;
  const sinceRaw = Number(params.get('since'));
  const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? Math.floor(sinceRaw) : 0;
  const timeoutRaw = Number(params.get('timeoutMs'));
  // Cap the long-poll at 20s so a webview poll never hangs the socket pool.
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.max(0, Math.min(20_000, timeoutRaw)) : 0;
  const ambientCadenceDue = params.get('ambient') === '1';
  const onDemandRequested = params.get('onDemand') === '1';

  try {
    const result = await pollFleetNarration({
      since,
      timeoutMs,
      ambientCadenceDue,
      onDemandRequested,
    });
    return NextResponse.json({
      ok: true,
      enabled: result.enabled,
      nextSince: result.nextSince,
      activeAgentCount: result.activeAgentCount,
      exceptionsOnly: result.exceptionsOnly,
      spoken: result.spoken,
      decisions: result.decisions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'narration poll failed';
    return NextResponse.json({ ok: false, enabled: true, reason: message }, { status: 502 });
  }
}
