import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { logUsage } from '@/lib/db/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Symon Realtime — usage metering (Track B, cost-visibility).
 *
 * The realtime session runs in the browser (WebRTC), so OpenAI's per-response
 * token usage arrives on the data channel in `response.done.usage`. The browser
 * forwards each one here; we price it and write a `usage_logs` row (operator
 * spend: userId=null + agentName, same convention as the Codex/Gemini writers in
 * cost-persistence.ts) so realtime voice spend shows up alongside everything
 * else — the whole point being you can run a real dogfood and SEE what it cost,
 * how much was cached, and what a fair price would be. Gated by /api/voice/
 * (middleware) + requirePanelAuth.
 */

// gpt-realtime-2.1-mini pricing (Q trial 2026-07-07) — USD per 1M tokens.
// textIn 0.60 and audioIn 10.00 are from the OpenAI announcement; textOut 1.60
// matches the "90% cheaper output" claim; audioOut + cached rates are
// BEST-EFFORT (2× audio-in / 10% of input, the flagship's ratios) — the TOKEN
// BREAKDOWN logged below is ground truth, cost is derived — verify all six
// against the OpenAI dashboard during the trial and adjust here.
// Flagship (gpt-realtime-2) rates for revert: 4.0 / 0.4 / 16.0 / 32.0 / 0.4 / 64.0.
const RATE_PER_1M = {
  textIn: 0.6,
  textCachedIn: 0.06,
  textOut: 1.6,
  audioIn: 10.0,
  audioCachedIn: 1.0,
  audioOut: 20.0,
} as const;
const PER = 1_000_000;
const DEFAULT_MODEL = 'gpt-realtime-2.1-mini';

interface RealtimeUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

const n = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { usage?: RealtimeUsage; model?: string; sessionKey?: string } | null;
  const usage = body?.usage;
  if (!usage || typeof usage !== 'object') {
    return NextResponse.json({ ok: false, reason: 'usage object is required.' }, { status: 400 });
  }
  const model = typeof body?.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
  const sessionKey = typeof body?.sessionKey === 'string' && body.sessionKey ? body.sessionKey : undefined;

  const inDet = usage.input_token_details ?? {};
  const cachedDet = inDet.cached_tokens_details ?? {};
  const cachedAudio = n(cachedDet.audio_tokens);
  const cachedText = n(cachedDet.text_tokens);
  // input_token_details.audio/text_tokens INCLUDE the cached portion → subtract.
  const audioIn = Math.max(0, n(inDet.audio_tokens) - cachedAudio);
  const textIn = Math.max(0, n(inDet.text_tokens) - cachedText);
  const outDet = usage.output_token_details ?? {};
  const audioOut = n(outDet.audio_tokens);
  const textOut = n(outDet.text_tokens);

  const costUsd =
    (audioIn * RATE_PER_1M.audioIn
      + cachedAudio * RATE_PER_1M.audioCachedIn
      + textIn * RATE_PER_1M.textIn
      + cachedText * RATE_PER_1M.textCachedIn
      + audioOut * RATE_PER_1M.audioOut
      + textOut * RATE_PER_1M.textOut) / PER;

  const inputTokens = n(usage.input_tokens);
  const outputTokens = n(usage.output_tokens);
  const cacheReadTokens = n(inDet.cached_tokens);

  // Full breakdown to the server log — the line to cross-check against the
  // OpenAI dashboard during the $5 dogfood (usage_logs only keeps the totals).
  console.log(
    `[realtime-usage] ${model} in=${inputTokens}(audio ${audioIn} + text ${textIn} + cachedAudio ${cachedAudio} + cachedText ${cachedText}) `
    + `out=${outputTokens}(audio ${audioOut} + text ${textOut}) cost=$${costUsd.toFixed(5)}`,
  );

  try {
    logUsage({
      userId: null,
      model,
      provider: 'openai',
      inputTokens,
      outputTokens,
      cacheReadTokens,
      costUsd,
      sessionKey,
      agentName: 'Symon Voice',
      requestType: 'completion',
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : 'failed to log usage' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, costUsd, inputTokens, outputTokens, cacheReadTokens });
}
