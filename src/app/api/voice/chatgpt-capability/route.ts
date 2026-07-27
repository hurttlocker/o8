import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { probeCodexVoiceCapability } from '@/lib/codex/appserver-probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Voice via your ChatGPT plan" capability probe (#1620 — voice slice).
 *
 * Wraps the existing Codex app-server probe (src/lib/codex/appserver-probe.ts,
 * already wired into /api/setup/detect) with a lean, single-purpose route so
 * the Settings surface doesn't pay for a full multi-CLI detection sweep just to
 * learn whether Codex's ChatGPT-OAuth realtime door is available. Gated in
 * middleware (/api/voice/, default-deny) + requirePanelAuth here, matching the
 * sibling narration route.
 */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  try {
    const capability = await probeCodexVoiceCapability({ timeoutMs: 2_500 });
    return NextResponse.json({ ok: true, capability });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'capability probe failed';
    return NextResponse.json({ ok: false, reason: message }, { status: 502 });
  }
}
