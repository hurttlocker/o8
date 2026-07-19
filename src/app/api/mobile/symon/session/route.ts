export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveOpenAIKey } from '@/lib/cortex/qa/llm/byok-keys';
import { resolveRealtimeAccess } from '@/lib/voice/realtime-access';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import {
  REALTIME_MODEL,
  DEFAULT_VOICE,
  DEFAULT_INSTRUCTIONS,
  PHONE_SURFACE_INSTRUCTIONS,
  RENDER_SURFACE_TOOL,
  REALTIME_INPUT_TRANSCRIPTION_MODEL,
  REALTIME_BASE_URL,
  CLIENT_SECRETS_URL,
  REALTIME_TOKEN_TTL_SECONDS,
  buildClientSecretsBody,
} from '@/lib/voice/realtime-session-config';

/**
 * Symon Agent Mode — ephemeral-token mint for the PHONE-hosted session.
 *
 * docs/symon-agent-mode.md §POST /api/mobile/symon/session. Mints an OpenAI
 * Realtime client token carrying the SAME session config the desk-mic session
 * uses — model + voice + instructions + the full tool-schema set — so the phone
 * (a dumb pipe) opens WebRTC straight to OpenAI with Symon's whole brain baked
 * in. Every tool call still executes on the Mac over the `symon` WS channel.
 *
 * Config parity is assembled from the shared source
 * (src/lib/voice/realtime-session-config.ts) — model / voice / instructions come
 * from there directly; the Rust-supplied tool schemas reach us through the same
 * webview eval bridge the desk session loads them from (`realtime_tools()`).
 *
 * Gated in middleware (loopback OR Bearer ws-token, the whole /api/mobile/*
 * family) AND requirePanelAuth here. Never throws — structured errors per the
 * contract's table (401/403/501/502/503).
 *
 * Log prefix: [symon-agent].
 */

const LOG = '[symon-agent]';

// Reuse the ONE per-server webview socket (shared with /api/mobile/symon,
// /api/browser/agent, /api/canvas/intent).
function webviewClient(): O8WebviewClient {
  const g = globalThis as { __o8BrowserAgentClient?: O8WebviewClient };
  if (!g.__o8BrowserAgentClient) g.__o8BrowserAgentClient = new O8WebviewClient();
  return g.__o8BrowserAgentClient;
}

// Stop a LIVE desk-mic session before minting (mutual exclusion — same code path
// as the operator toggling it off: the RealtimeVoiceHost listener runs the exact
// toggle() the hotkey runs). Gated on the live status so an IDLE desk is never
// accidentally STARTED by the toggle. Returns whether a desk session was live.
const STOP_DESK_EVAL = `(() => {
  const w = window;
  const st = typeof w.__o8RealtimeStatus === 'string' ? w.__o8RealtimeStatus : 'idle';
  const live = st === 'live' || st === 'connecting' || st === 'requesting-mic';
  if (live && w.__o8SymonRemoteReady === true) {
    w.dispatchEvent(new CustomEvent('o8:symon-remote-toggle'));
  }
  return JSON.stringify({ deskWasLive: live });
})()`;

// Read the tool schemas + voice pref that the RealtimeVoiceHost agent bridge
// publishes on window (it loaded them from `realtime_tools()` via the compiled
// Tauri invoke). We do NOT invoke Tauri from raw eval (bare-specifier dynamic
// imports don't resolve in an eval string) — the webview publishes for us.
const TOOLS_EVAL = `(() => {
  const w = window;
  const A = w.__o8SymonAgent;
  if (!A) return JSON.stringify({ ready: false, reason: 'no_bridge' });
  if (!A.config || !Array.isArray(A.config.tools)) return JSON.stringify({ ready: false, reason: 'loading' });
  return JSON.stringify({ ready: true, tools: A.config.tools, voice: typeof A.config.voice === 'string' ? A.config.voice : null });
})()`;

interface BridgeResult {
  deskWasLive: boolean;
  tools: Array<Record<string, unknown>>;
  voice: string;
}

class BridgeUnavailable extends Error {}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Reach the webview: stop a live desk session, then poll for the published tool
 * schemas (the host publishes them shortly after mount). Throws BridgeUnavailable
 * if the eval socket is unreachable (app not running) or the host never publishes
 * — the caller maps that to 503 desktop_unavailable.
 */
async function reachWebview(): Promise<BridgeResult> {
  const client = webviewClient();

  let deskWasLive = false;
  try {
    const { result } = await client.evalJs(STOP_DESK_EVAL);
    deskWasLive = Boolean((JSON.parse(result) as { deskWasLive?: boolean }).deskWasLive);
  } catch (error) {
    throw new BridgeUnavailable(error instanceof Error ? error.message : 'webview eval bridge unreachable');
  }

  // Poll ~3s for the host's tool-schema publish (fresh-mount race).
  const deadline = Date.now() + 3_000;
  let lastReason = 'loading';
  while (Date.now() < deadline) {
    let parsed: { ready?: boolean; tools?: unknown; voice?: unknown; reason?: string };
    try {
      const { result } = await client.evalJs(TOOLS_EVAL);
      parsed = JSON.parse(result);
    } catch (error) {
      throw new BridgeUnavailable(error instanceof Error ? error.message : 'webview eval bridge unreachable');
    }
    if (parsed.ready && Array.isArray(parsed.tools)) {
      return {
        deskWasLive,
        tools: parsed.tools as Array<Record<string, unknown>>,
        voice: typeof parsed.voice === 'string' && parsed.voice ? parsed.voice : DEFAULT_VOICE,
      };
    }
    lastReason = parsed.reason || 'loading';
    await sleep(200);
  }
  throw new BridgeUnavailable(`voice host has not published tool schemas (${lastReason})`);
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  // Access gating — mirrors the desk mint exactly (realtime-access.ts).
  const byokKey = await resolveOpenAIKey();
  const access = await resolveRealtimeAccess(Boolean(byokKey));
  if (access.mode === 'locked') {
    return NextResponse.json({ ok: false, error: 'locked', detail: access.reason }, { status: 403 });
  }
  if (access.mode === 'managed') {
    // Entitled, but the managed realtime proxy isn't wired and no BYOK key is
    // present — realtime cannot run without a key in v1.
    return NextResponse.json({ ok: false, error: 'no_key', detail: access.reason }, { status: 501 });
  }
  // byok mode ⇒ byokKey is non-null here.

  // Reach the webview: preempt a live desk session + pull the tool schemas.
  let bridge: BridgeResult;
  try {
    bridge = await reachWebview();
  } catch (error) {
    if (error instanceof BridgeUnavailable) {
      console.warn(`${LOG} desktop_unavailable: ${error.message}`);
      return NextResponse.json(
        { ok: false, error: 'desktop_unavailable', detail: error.message },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'desktop_unavailable', detail: error instanceof Error ? error.message : 'webview bridge failed' },
      { status: 503 },
    );
  }

  const sessionId = `sym-${randomUUID()}`;
  const model = REALTIME_MODEL;
  const voice = bridge.voice;

  // Mint the ephemeral token carrying the FULL config (parity with desk). Plain
  // fetch on the operator's BYOK key — the raw key never leaves the Mac.
  try {
    const mint = await fetch(CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${byokKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildClientSecretsBody(
          {
            model,
            voice,
            // Phone-only superset: the desk-mic tool set + the client-rendered
            // surface tool, and the persona + its surface-authoring guidance.
            // Only the phone has a surface renderer, so the desk mint is untouched.
            instructions: DEFAULT_INSTRUCTIONS + PHONE_SURFACE_INSTRUCTIONS,
            tools: [...bridge.tools, RENDER_SURFACE_TOOL],
            inputTranscriptionModel: REALTIME_INPUT_TRANSCRIPTION_MODEL,
            micProfile: 'near_field',
          },
          REALTIME_TOKEN_TTL_SECONDS,
        ),
      ),
    });

    const data = (await mint.json().catch(() => null)) as
      | { value?: string; expires_at?: number; error?: { message?: string } }
      | null;

    if (!mint.ok || !data?.value) {
      const detail = data?.error?.message || `OpenAI returned ${mint.status}`;
      console.warn(`${LOG} mint_failed: ${detail}`);
      return NextResponse.json({ ok: false, error: 'mint_failed', detail }, { status: 502 });
    }

    // OpenAI reports expires_at in unix SECONDS; the contract wants epoch millis.
    const expiresAt = typeof data.expires_at === 'number'
      ? data.expires_at * 1000
      : Date.now() + REALTIME_TOKEN_TTL_SECONDS * 1000;

    console.log(
      `${LOG} minted ${sessionId} (model=${model} voice=${voice} tools=${bridge.tools.length}` +
        `${bridge.deskWasLive ? ' preempted=desk' : ''})`,
    );

    return NextResponse.json({
      ok: true,
      session: {
        sessionId,
        clientSecret: data.value,
        expiresAt,
        model,
        voice,
        baseUrl: REALTIME_BASE_URL,
      },
      preempted: bridge.deskWasLive ? 'desk' : null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'realtime session mint failed';
    console.warn(`${LOG} mint_failed (exception): ${detail}`);
    return NextResponse.json({ ok: false, error: 'mint_failed', detail }, { status: 502 });
  }
}
