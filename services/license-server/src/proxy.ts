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
 * Two routes the desktop authenticates to with its EdDSA plan token, so users
 * don't bring their own keys — "what we give them":
 *   - POST /v1/inference  — OpenRouter chat-completions passthrough
 *   - POST /v1/embeddings — Gemini embedContent passthrough
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
const DAILY_CAP_MICRO_USD: Record<Plan, number> = {
  free: usdToMicro(envUsd('PROXY_CAP_FREE_USD', 0.1)),
  pro: usdToMicro(envUsd('PROXY_CAP_PRO_USD', 0.5)),
  team: usdToMicro(envUsd('PROXY_CAP_TEAM_USD', 2.0)),
};

/** Gemini embeddings have no cost field — estimate from input length. */
const EMBED_PRICE_PER_M_USD = envUsd('PROXY_EMBED_PRICE_PER_M_USD', 0.15);
const DEFAULT_EMBED_MODEL = 'gemini-embedding-001';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ── Auth ──────────────────────────────────────────────────────────────────────

type AuthResult =
  | { ok: true; plan: Plan; sub: string }
  | { ok: false; status: 401; error: string };

/** Verify the Bearer plan token and resolve { plan, sub } for metering. */
async function authPlan(c: Context): Promise<AuthResult> {
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
  kind: 'inference' | 'embeddings';
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
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
