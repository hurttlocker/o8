import { randomUUID } from 'node:crypto';

import { and, eq, gte, sql } from 'drizzle-orm';
import type { Context } from 'hono';

import { db } from './db/client.js';
import { proxyUsage } from './db/schema.js';
import { env } from './env.js';
import type { Plan } from './mint.js';
import { validateEntitlement } from './validate.js';

/**
 * Managed-inference proxy (monetization Step 1).
 *
 * Routes the desktop authenticates to with its EdDSA plan token, so users
 * don't bring their own keys — "what we give them":
 *   - POST /v1/inference  — OpenRouter chat-completions passthrough
 *   - POST /v1/embeddings — Gemini embedContent passthrough
 *   - POST /v1/gemini     — Gemini generateContent passthrough (Symon agent,
 *                           Ask, dictation polish — native functionCall protocol)
 *   - POST /v1/transcribe — OpenRouter audio/transcriptions passthrough
 *
 * Both: verify the plan token (signature + exp + revocation, via
 * validateEntitlement) → enforce a per-account daily spend cap → forward to the
 * upstream with OUR funded key → log exact/estimated cost to `proxy_usage`
 * (the meter AND the COGS ledger we aggregate to set pricing in Step 5).
 *
 * Our keys live ONLY here (Railway env), never in the desktop build. When a key
 * is unset the corresponding route returns 503 so the service still boots.
 */

// ── Tuning (env-overridable; tune from real COGS data in Step 5) ──────────────

const MICRO = 1_000_000;
const usdToMicro = (usd: number): number => Math.round(usd * MICRO);

function envUsd(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Per-account daily spend cap (micro-USD), keyed by plan. Provisional. */
export const DAILY_CAP_MICRO_USD: Record<Plan, number> = {
  free: usdToMicro(envUsd('PROXY_CAP_FREE_USD', 0.1)),
  pro: usdToMicro(envUsd('PROXY_CAP_PRO_USD', 0.5)),
  team: usdToMicro(envUsd('PROXY_CAP_TEAM_USD', 2.0)),
  // Founders get managed inference "included for life" — THIS per-account daily
  // ceiling is the solvency guarantee (docs/founding-operator-tier.md §Pricing),
  // never lifetime-unlimited. Env-tunable from real COGS data.
  founder: usdToMicro(envUsd('PROXY_CAP_FOUNDER_USD', 2.0)),
};

/** Gemini embeddings have no cost field — estimate from input length. */
const EMBED_PRICE_PER_M_USD = envUsd('PROXY_EMBED_PRICE_PER_M_USD', 0.15);
const DEFAULT_EMBED_MODEL = 'gemini-embedding-001';

/**
 * Gemini generateContent has no cost field either — only `usageMetadata` token
 * counts. Price per 1M tokens (Flash-class default; refine in the Step-5 COGS
 * pass). Env-overridable; the per-account daily cap is the real guardrail.
 */
const GEMINI_IN_PRICE_PER_M_USD = envUsd('PROXY_GEMINI_IN_PER_M_USD', 0.3);
const GEMINI_OUT_PRICE_PER_M_USD = envUsd('PROXY_GEMINI_OUT_PER_M_USD', 2.5);
// Gemini 3 Flash (preview) is priced higher than 2.5-flash: $0.50/1M in, $3.00/1M out.
const GEMINI3_IN_PRICE_PER_M_USD = envUsd('PROXY_GEMINI3_IN_PER_M_USD', 0.5);
const GEMINI3_OUT_PRICE_PER_M_USD = envUsd('PROXY_GEMINI3_OUT_PER_M_USD', 3.0);
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** Per-1M-token prices for the served Gemini model (Google returns no cost field). */
function geminiPricesFor(model: string): { inPerM: number; outPerM: number } {
  if (/gemini-3/i.test(model)) {
    return { inPerM: GEMINI3_IN_PRICE_PER_M_USD, outPerM: GEMINI3_OUT_PRICE_PER_M_USD };
  }
  return { inPerM: GEMINI_IN_PRICE_PER_M_USD, outPerM: GEMINI_OUT_PRICE_PER_M_USD };
}

/** Exact-token, model-accurate Gemini cost (micro-USD) — tokens from usageMetadata. */
function geminiCostMicroUsd(promptTokens: number, completionTokens: number, model: string): number {
  const { inPerM, outPerM } = geminiPricesFor(model);
  const usd = (promptTokens * inPerM + completionTokens * outPerM) / 1_000_000;
  return usdToMicro(usd);
}

/**
 * OpenRouter's audio/transcriptions returns no cost field, so whisper spend must
 * be ESTIMATED (it was hardcoded to $0 before, which hid dictation spend). Price
 * per audio-MINUTE; duration derived from the input_audio byte size at the
 * recorder's bitrate. Amounts are tiny but no longer zero, so founders see them.
 * Env-tunable; the per-account daily cap is still the real guardrail.
 */
// Only the last-resort byte fallback needs a rate — the desktop records 16 kHz
// mono 16-bit WAV = 32000 bytes/s. Per-minute price (~$0.0002/min, DeepInfra's
// real whisper-large-v3-turbo rate) is only used if OpenRouter reports neither
// cost nor seconds; env-tunable.
const WHISPER_PRICE_PER_MIN_USD = envUsd('PROXY_WHISPER_PRICE_PER_MIN_USD', 0.0002);
const DICTATION_BITRATE_BYTES_PER_SEC = 32000; // 16 kHz · mono · 16-bit WAV

/**
 * DEAD-ACCURATE transcribe cost. OpenRouter's audio/transcriptions response
 * carries usage.cost (the EXACT charge) and usage.seconds (real duration), so we
 * prefer those over any estimate. Order: exact cost → duration × rate → byte
 * estimate (only if the provider reports nothing).
 */
function transcribeCost(json: Record<string, unknown>, body: Record<string, unknown>): number {
  const usage = json.usage as { cost?: unknown; seconds?: unknown } | undefined;
  if (usage && typeof usage.cost === 'number' && usage.cost > 0) {
    return usdToMicro(usage.cost); // exact — what OpenRouter actually charged
  }
  if (usage && typeof usage.seconds === 'number' && usage.seconds > 0) {
    return usdToMicro((usage.seconds / 60) * WHISPER_PRICE_PER_MIN_USD);
  }
  // Last resort: input_audio is a bare base64 string OR { data, format }.
  const ia = body.input_audio;
  const b64 =
    typeof ia === 'string'
      ? ia
      : ia && typeof ia === 'object' && typeof (ia as { data?: unknown }).data === 'string'
        ? (ia as { data: string }).data
        : '';
  if (!b64) return 0;
  const seconds = Math.floor(b64.length * 0.75) / DICTATION_BITRATE_BYTES_PER_SEC;
  return usdToMicro((seconds / 60) * WHISPER_PRICE_PER_MIN_USD);
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_TRANSCRIBE_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

// ── Auth ──────────────────────────────────────────────────────────────────────

type AuthResult =
  | { ok: true; plan: Plan; sub: string }
  | { ok: false; status: 401; error: string };

/** Verify the Bearer plan token and resolve { plan, sub } for metering. Shared
 *  with the telemetry ingest (analytics.ts) so both authenticate identically. */
export async function authPlan(c: Context): Promise<AuthResult> {
  const header = c.req.header('authorization');
  const token = header?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'missing plan token' };

  const result = await validateEntitlement(token);
  if (!result.valid || !result.plan) {
    return { ok: false, status: 401, error: result.reason ?? 'invalid plan token' };
  }
  if (!result.sub) {
    return { ok: false, status: 401, error: 'plan token missing sub (account) claim' };
  }
  return { ok: true, plan: result.plan, sub: result.sub };
}

// ── Meter ───────────────────────────────────────────────────────────────────

/** Sum today's (UTC) spend for an account, in micro-USD. */
async function todaySpendMicroUsd(sub: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${proxyUsage.costMicroUsd}), 0)` })
    .from(proxyUsage)
    .where(and(eq(proxyUsage.sub, sub), gte(proxyUsage.createdAt, startOfDay)));
  return Number(rows[0]?.total ?? 0);
}

async function recordUsage(row: {
  sub: string;
  plan: Plan;
  kind: 'inference' | 'embeddings' | 'transcribe' | 'gemini';
  model?: string | null;
  costMicroUsd: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
}): Promise<void> {
  try {
    await db.insert(proxyUsage).values({
      id: randomUUID(),
      sub: row.sub,
      plan: row.plan,
      kind: row.kind,
      model: row.model ?? null,
      costMicroUsd: Math.max(0, Math.round(row.costMicroUsd)),
      promptTokens: row.promptTokens ?? null,
      completionTokens: row.completionTokens ?? null,
    });
  } catch (err) {
    // Never fail the user's request because the ledger write failed.
    console.error('[proxy] failed to record usage:', err);
  }
}

/** JSON 402 when the account is over its daily cap. */
function overCap(c: Context, plan: Plan, spent: number, cap: number): Response {
  return c.json(
    { error: 'daily cap reached', plan, spentMicroUsd: spent, capMicroUsd: cap },
    402,
  );
}

/** Forward an upstream error response verbatim (preserves status + body). */
async function forwardUpstreamError(upstream: Response): Promise<Response> {
  const text = await upstream.text().catch(() => '');
  return new Response(text || JSON.stringify({ error: `upstream ${upstream.status}` }), {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

// ── Streaming meter ───────────────────────────────────────────────────────────
//
// Pass the SSE stream through to the client UNCHANGED while scanning for the
// final `usage` chunk (OpenRouter emits it when usage.include + stream_options.
// include_usage are set, which handleInference injects). Without this, a
// streamed call would be an unmetered bypass of the daily cap.

function meterStream(
  upstream: ReadableStream<Uint8Array>,
  onUsage: (costUsd: number, model: string, promptTokens?: number, completionTokens?: number) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = '';
  let captured = false;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk); // forward unchanged — never alter the stream
      if (captured) return;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload) as {
            model?: string;
            usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
          };
          if (obj.usage && typeof obj.usage.cost === 'number') {
            onUsage(obj.usage.cost, obj.model ?? '', obj.usage.prompt_tokens, obj.usage.completion_tokens);
            captured = true;
          }
        } catch {
          // Partial JSON spanning chunks — ignore; the next chunk completes it.
        }
      }
    },
  });
  return upstream.pipeThrough(transform);
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** POST /v1/inference — OpenRouter chat-completions passthrough (our key). */
export async function handleInference(c: Context): Promise<Response> {
  const auth = await authPlan(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const { plan, sub } = auth;

  if (!env.OPENROUTER_API_KEY) {
    return c.json({ error: 'inference upstream not configured' }, 503);
  }

  const spent = await todaySpendMicroUsd(sub);
  const cap = DAILY_CAP_MICRO_USD[plan];
  if (spent >= cap) return overCap(c, plan, spent, cap);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  // Always ask OpenRouter to report the call's cost so we meter exact dollars.
  body.usage = { include: true };
  const streaming = body.stream === true;
  if (streaming) body.stream_options = { include_usage: true };

  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://o8.run',
        'X-Title': 'o8 managed inference',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return c.json({ error: `upstream fetch failed: ${(err as Error).message}` }, 502);
  }

  if (!upstream.ok) return forwardUpstreamError(upstream);

  if (!streaming) {
    const json = (await upstream.json()) as {
      model?: string;
      usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
    };
    const cost = typeof json.usage?.cost === 'number' ? json.usage.cost : 0;
    await recordUsage({
      sub,
      plan,
      kind: 'inference',
      model: json.model,
      costMicroUsd: usdToMicro(cost),
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
    });
    return c.json(json);
  }

  // Streaming: pass the SSE through unchanged, meter the final usage chunk.
  if (!upstream.body) return c.json({ error: 'upstream returned no stream' }, 502);
  const metered = meterStream(upstream.body, (cost, model, pt, ct) => {
    void recordUsage({
      sub,
      plan,
      kind: 'inference',
      model,
      costMicroUsd: usdToMicro(cost),
      promptTokens: pt,
      completionTokens: ct,
    });
  });
  return new Response(metered, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

/** POST /v1/embeddings — Gemini embedContent passthrough (our key). */
export async function handleEmbeddings(c: Context): Promise<Response> {
  const auth = await authPlan(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const { plan, sub } = auth;

  if (!env.GEMINI_API_KEY) {
    return c.json({ error: 'embeddings upstream not configured' }, 503);
  }

  const spent = await todaySpendMicroUsd(sub);
  const cap = DAILY_CAP_MICRO_USD[plan];
  if (spent >= cap) return overCap(c, plan, spent, cap);

  let body: {
    text?: unknown;
    input?: unknown;
    model?: unknown;
    outputDimensionality?: unknown;
    dimensions?: unknown;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  // Accept our gemini-embed shape ({text}) or the OpenAI shape ({input}).
  const text =
    typeof body.text === 'string'
      ? body.text
      : typeof body.input === 'string'
        ? body.input
        : '';
  if (!text.trim()) return c.json({ error: 'missing text/input' }, 400);

  const model = typeof body.model === 'string' && body.model.trim() ? body.model : DEFAULT_EMBED_MODEL;
  const dims =
    typeof body.outputDimensionality === 'number'
      ? body.outputDimensionality
      : typeof body.dimensions === 'number'
        ? body.dimensions
        : 768;

  let upstream: Response;
  try {
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({ content: { parts: [{ text }] }, outputDimensionality: dims }),
      },
    );
  } catch (err) {
    return c.json({ error: `upstream fetch failed: ${(err as Error).message}` }, 502);
  }

  if (!upstream.ok) return forwardUpstreamError(upstream);

  const json = (await upstream.json()) as Record<string, unknown>;
  // No cost field on embeddings — estimate ~chars/4 tokens at the embed price.
  const estTokens = Math.ceil(text.length / 4);
  const costMicroUsd = Math.round(estTokens * EMBED_PRICE_PER_M_USD);
  await recordUsage({ sub, plan, kind: 'embeddings', model, costMicroUsd, promptTokens: estTokens });
  return c.json(json);
}

/**
 * POST /v1/gemini — Gemini `generateContent` passthrough (our key).
 *
 * Serves the Rust voice surface: the Symon agent (tool-calling functionCall
 * loop), the Ask path, and dictation polish — all of which speak Gemini's
 * native REST shape. The desktop sends the EXACT generateContent body it would
 * send Google (`contents` / `tools` / `generationConfig`) plus a top-level
 * `model` field (Google puts the model in the URL, which we own here). We strip
 * `model`, forward the rest verbatim, and meter from `usageMetadata` token
 * counts (generateContent reports no cost field).
 */
export async function handleGeminiGenerate(c: Context): Promise<Response> {
  const auth = await authPlan(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const { plan, sub } = auth;

  if (!env.GEMINI_API_KEY) {
    return c.json({ error: 'gemini upstream not configured' }, 503);
  }

  const spent = await todaySpendMicroUsd(sub);
  const cap = DAILY_CAP_MICRO_USD[plan];
  if (spent >= cap) return overCap(c, plan, spent, cap);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const model =
    typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_GEMINI_MODEL;
  // `model` is our routing field — Google wants it in the URL, not the body.
  delete body.model;

  let upstream: Response;
  try {
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(body),
      },
    );
  } catch (err) {
    return c.json({ error: `upstream fetch failed: ${(err as Error).message}` }, 502);
  }

  if (!upstream.ok) return forwardUpstreamError(upstream);

  const json = (await upstream.json()) as {
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const promptTokens = json.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = json.usageMetadata?.candidatesTokenCount ?? 0;
  await recordUsage({
    sub,
    plan,
    kind: 'gemini',
    model,
    costMicroUsd: geminiCostMicroUsd(promptTokens, completionTokens, model),
    promptTokens,
    completionTokens,
  });
  return c.json(json);
}

// ── Deepgram primary transcribe arm ─────────────────────────────────────────
// Harness verdict 2026-07-07 (#1494): Deepgram Nova-3 p50 361–441ms with 147ms
// mins; verbatim quality matches whisper once smart_format is OFF and numerals
// ON ("ship 0.1563 tonight" survives). Pricing ~$0.0043/min billed per second —
// a heavy founder is under $1/month, and the $200 signup credit funds the tier
// until subscriptions launch. OpenRouter whisper remains the fallback arm; any
// Deepgram failure falls straight through, never a user-visible error.

const DEEPGRAM_LISTEN_URL =
  'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=false&punctuate=true&numerals=true';
const DEEPGRAM_PRICE_PER_MIN_USD = envUsd('PROXY_DEEPGRAM_PRICE_PER_MIN_USD', 0.0043);

interface DeepgramListenResponse {
  metadata?: { duration?: number };
  results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
}

/** Decode the OpenRouter-shaped body's input_audio into raw bytes + format. */
function decodeInputAudio(body: Record<string, unknown>): { bytes: Buffer; format: string } | null {
  const ia = body.input_audio;
  const data = typeof ia === 'string'
    ? ia
    : ia && typeof ia === 'object' && typeof (ia as { data?: unknown }).data === 'string'
      ? (ia as { data: string }).data
      : '';
  if (!data) return null;
  const format = ia && typeof ia === 'object' && typeof (ia as { format?: unknown }).format === 'string'
    ? (ia as { format: string }).format
    : 'wav';
  try {
    return { bytes: Buffer.from(data, 'base64'), format };
  } catch {
    return null;
  }
}

/**
 * Try Deepgram; null on ANY failure so the caller falls through to OpenRouter.
 * Returns a whisper-shaped response ({ text }) — the desktop client parses the
 * same shape regardless of which arm answered.
 */
async function transcribeViaDeepgram(
  body: Record<string, unknown>,
): Promise<{ json: Record<string, unknown>; costMicroUsd: number } | null> {
  const audio = decodeInputAudio(body);
  if (!audio || audio.bytes.length === 0) return null;

  let url = DEEPGRAM_LISTEN_URL;
  if (typeof body.language === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.language)) {
    url += `&language=${body.language}`;
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        'Content-Type': `audio/${audio.format}`,
      },
      body: audio.bytes,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  if (!upstream.ok) return null;

  let parsed: DeepgramListenResponse;
  try {
    parsed = (await upstream.json()) as DeepgramListenResponse;
  } catch {
    return null;
  }
  const text = parsed.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
  const seconds = typeof parsed.metadata?.duration === 'number' ? parsed.metadata.duration : 0;
  // Empty transcript on real decoded audio = SILENCE, and that's a successful
  // answer — do NOT fall through to whisper, which hallucinates filler text on
  // silent clips ("Thank you.") that would paste as garbage. Only a decode
  // failure (duration 0) falls through. (Break-test 2026-07-07.)
  if (!text && seconds <= 0) return null;
  const costMicroUsd = usdToMicro((seconds / 60) * DEEPGRAM_PRICE_PER_MIN_USD);
  return {
    json: {
      text,
      model: 'deepgram/nova-3',
      usage: { seconds },
    },
    costMicroUsd,
  };
}

/**
 * POST /v1/transcribe — Deepgram Nova-3 primary (our key, verbatim params),
 * OpenRouter audio/transcriptions fallback (our key). The desktop sends the
 * same JSON body it would send to OpenRouter directly ({ model, input_audio,
 * language, temperature }); both arms answer whisper-shaped ({ text, ... }).
 */
export async function handleTranscribe(c: Context): Promise<Response> {
  const auth = await authPlan(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const { plan, sub } = auth;

  if (!env.DEEPGRAM_API_KEY && !env.OPENROUTER_API_KEY) {
    return c.json({ error: 'transcribe upstream not configured' }, 503);
  }

  const spent = await todaySpendMicroUsd(sub);
  const cap = DAILY_CAP_MICRO_USD[plan];
  if (spent >= cap) return overCap(c, plan, spent, cap);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  // Primary arm: Deepgram (fast, per-second billed). Fall through on failure.
  if (env.DEEPGRAM_API_KEY) {
    const result = await transcribeViaDeepgram(body);
    if (result) {
      await recordUsage({
        sub,
        plan,
        kind: 'transcribe',
        model: 'deepgram/nova-3',
        costMicroUsd: result.costMicroUsd,
      });
      return c.json(result.json);
    }
    if (!env.OPENROUTER_API_KEY) {
      return c.json({ error: 'transcribe upstream failed' }, 502);
    }
  }

  // Ask OpenRouter to report the call's usage.cost so we meter the EXACT charge.
  body.usage = { include: true };

  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_TRANSCRIBE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://o8.run',
        'X-Title': 'o8 managed inference',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return c.json({ error: `upstream fetch failed: ${(err as Error).message}` }, 502);
  }

  if (!upstream.ok) return forwardUpstreamError(upstream);

  const json = (await upstream.json()) as Record<string, unknown>;
  const model = typeof body.model === 'string' ? body.model : null;
  await recordUsage({ sub, plan, kind: 'transcribe', model, costMicroUsd: transcribeCost(json, body) });
  return c.json(json);
}
