import { NextRequest, NextResponse } from 'next/server';

import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveCodexRealtimeTransportAccess } from '@/lib/voice/realtime-access';
import {
  CodexRealtimeTransportError,
  appendCodexRealtimeAudio,
  appendCodexRealtimeSpeech,
  appendCodexRealtimeText,
  pollCodexRealtimeEvents,
  startCodexRealtimeSession,
  stopCodexRealtimeSession,
} from '@/lib/voice/codex-realtime-transport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LONG_POLL_MS = 20_000;
const MAX_SDP_CHARS = 512 * 1024;
const MAX_AUDIO_BASE64_CHARS = 512 * 1024;
const MAX_TEXT_CHARS = 64 * 1024;

function stringField(
  body: Record<string, unknown>,
  key: string,
  maxLength = MAX_TEXT_CHARS,
): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof CodexRealtimeTransportError) {
    return NextResponse.json(
      { ok: false, code: error.code, reason: error.message },
      { status: error.status },
    );
  }
  return NextResponse.json(
    {
      ok: false,
      code: 'codex_realtime_failed',
      reason: error instanceof Error ? error.message : 'Codex realtime request failed.',
    },
    { status: 502 },
  );
}

function publicCapability(access: Awaited<ReturnType<typeof resolveCodexRealtimeTransportAccess>>) {
  const capability = access.capability;
  return {
    checkedAt: capability.checkedAt,
    capable: capability.capable,
    whyNot: capability.whyNot,
    installation: {
      installed: capability.installation.installed,
      version: capability.installation.version,
    },
    appServer: {
      reachable: capability.appServer.reachable,
      transports: capability.appServer.transports,
      supportedTransports: capability.appServer.supportedTransports,
      realtimeMethods: capability.appServer.realtimeMethods,
      missingRealtimeMethods: capability.appServer.missingRealtimeMethods,
    },
    auth: {
      mode: capability.auth.mode,
      chatgptOAuth: capability.auth.chatgptOAuth,
    },
    realtime: {
      enabled: capability.realtime.enabled,
      featureEnabled: capability.realtime.featureEnabled,
      realtimeSectionPresent: capability.realtime.realtimeSectionPresent,
      websocketModeEnabled: capability.realtime.websocketModeEnabled,
      whyNot: capability.realtime.whyNot,
    },
  };
}

/**
 * GET without a session id is the fenced capability check. GET with sessionId
 * long-polls the ephemeral thread/realtime event stream; its wait is hard-capped
 * at 20 seconds so a stalled app-server cannot exhaust the Next socket pool.
 */
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const sessionId = request.nextUrl.searchParams.get('sessionId')?.trim() ?? '';
  if (!sessionId) {
    try {
      const access = await resolveCodexRealtimeTransportAccess();
      return NextResponse.json({
        ok: true,
        mode: access.mode,
        s2s: access.s2s,
        available: access.available,
        reason: access.reason,
        capability: publicCapability(access),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  const sinceRaw = Number(request.nextUrl.searchParams.get('since'));
  const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? Math.floor(sinceRaw) : 0;
  const timeoutRaw = Number(request.nextUrl.searchParams.get('timeoutMs'));
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.max(0, Math.min(MAX_LONG_POLL_MS, Math.floor(timeoutRaw)))
    : 0;
  try {
    const result = await pollCodexRealtimeEvents(sessionId, since, timeoutMs);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Mutations stay on one explicitly-gated route so the experimental RPC surface
 * remains easy to remove or rename. Every action validates its bounded payload
 * before it reaches the local Codex app-server, and every failure is structured.
 */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json(
      { ok: false, code: 'invalid_json', reason: 'A JSON request body is required.' },
      { status: 400 },
    );
  }
  const action = stringField(body, 'action', 32);

  try {
    if (action === 'start') {
      const rawSdp = body.sdp;
      if (
        rawSdp !== undefined
        && (typeof rawSdp !== 'string' || rawSdp.length > MAX_SDP_CHARS || !rawSdp.startsWith('v='))
      ) {
        return NextResponse.json(
          { ok: false, code: 'invalid_sdp', reason: 'sdp must be a bounded WebRTC offer.' },
          { status: 400 },
        );
      }
      const rawTransport = body.transport;
      if (
        rawTransport !== undefined
        && rawTransport !== 'webrtc'
        && rawTransport !== 'websocket'
      ) {
        return NextResponse.json(
          { ok: false, code: 'invalid_transport', reason: 'transport must be webrtc or websocket.' },
          { status: 400 },
        );
      }
      if (rawTransport === 'webrtc' && typeof rawSdp !== 'string') {
        return NextResponse.json(
          { ok: false, code: 'sdp_required', reason: 'WebRTC transport requires an SDP offer.' },
          { status: 400 },
        );
      }
      const rawModality = body.outputModality;
      if (rawModality !== undefined && rawModality !== 'audio' && rawModality !== 'text') {
        return NextResponse.json(
          { ok: false, code: 'invalid_output_modality', reason: 'outputModality must be audio or text.' },
          { status: 400 },
        );
      }
      const result = await startCodexRealtimeSession({
        sdp: typeof rawSdp === 'string' ? rawSdp : undefined,
        transport: rawTransport === 'webrtc' || rawTransport === 'websocket'
          ? rawTransport
          : undefined,
        outputModality: rawModality === 'text' || rawModality === 'audio'
          ? rawModality
          : undefined,
        prompt: body.prompt === null ? null : stringField(body, 'prompt', 32 * 1024),
        model: stringField(body, 'model', 128),
        voice: stringField(body, 'voice', 64),
        allowTextFallback: body.allowTextFallback !== false,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    const sessionId = stringField(body, 'sessionId', 256)?.trim() ?? '';
    if (!sessionId) {
      return NextResponse.json(
        { ok: false, code: 'session_id_required', reason: 'sessionId is required.' },
        { status: 400 },
      );
    }

    if (action === 'appendText' || action === 'appendSpeech') {
      const text = stringField(body, 'text')?.trim() ?? '';
      if (!text) {
        return NextResponse.json(
          { ok: false, code: 'text_required', reason: 'A non-empty bounded text value is required.' },
          { status: 400 },
        );
      }
      if (action === 'appendSpeech') {
        await appendCodexRealtimeSpeech(sessionId, text);
      } else {
        const rawRole = body.role;
        const role = rawRole === 'developer' || rawRole === 'assistant' ? rawRole : 'user';
        await appendCodexRealtimeText(sessionId, text, role);
      }
      return NextResponse.json({ ok: true });
    }

    if (action === 'appendAudio') {
      const audio = body.audio && typeof body.audio === 'object' && !Array.isArray(body.audio)
        ? body.audio as Record<string, unknown>
        : null;
      const data = typeof audio?.data === 'string' ? audio.data : '';
      const sampleRate = audio?.sampleRate;
      const numChannels = audio?.numChannels;
      const samplesPerChannel = audio?.samplesPerChannel;
      const itemId = audio?.itemId;
      if (
        !data
        || data.length > MAX_AUDIO_BASE64_CHARS
        || typeof sampleRate !== 'number'
        || !Number.isFinite(sampleRate)
        || sampleRate <= 0
        || sampleRate > 192_000
        || typeof numChannels !== 'number'
        || !Number.isInteger(numChannels)
        || numChannels < 1
        || numChannels > 8
      ) {
        return NextResponse.json(
          { ok: false, code: 'invalid_audio', reason: 'audio must be a bounded base64 PCM chunk with valid format metadata.' },
          { status: 400 },
        );
      }
      await appendCodexRealtimeAudio(sessionId, {
        data,
        sampleRate,
        numChannels,
        samplesPerChannel: typeof samplesPerChannel === 'number'
          ? samplesPerChannel
          : null,
        itemId: typeof itemId === 'string' ? itemId : null,
      });
      return NextResponse.json({ ok: true });
    }

    if (action === 'stop') {
      await stopCodexRealtimeSession(sessionId);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(
      {
        ok: false,
        code: 'invalid_action',
        reason: 'action must be start, appendAudio, appendText, appendSpeech, or stop.',
      },
      { status: 400 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
