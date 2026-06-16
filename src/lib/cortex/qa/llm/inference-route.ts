/**
 * Inference route resolver (monetization Step 2).
 *
 * Decides, for a given upstream call, whether to go DIRECT (the user's own key)
 * or through the o8 managed-inference PROXY (our key, metered server-side):
 *
 *   1. local key present            → direct  (today's behavior; founder unchanged)
 *   2. no local key + plan token     → proxy   (Railway /v1/* with the JWT as bearer)
 *   3. neither                       → null    (caller falls through to CLI tiers)
 *
 * The proxy bearer is the EdDSA license JWT already persisted to entitlement.json
 * (license.ts `licenseKey`, surfaced by `readCachedEntitlement`). Server-side
 * only — reads the entitlement file + the BYOK key chain.
 */

import 'server-only';

import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';
import { readCachedEntitlement } from '@/lib/entitlement/license';

const DEFAULT_PROXY_BASE = 'https://o8-license-server-production.up.railway.app';

/** Base URL of the managed-inference proxy (the license server). Overridable. */
export function proxyBaseUrl(): string {
  const raw = process.env.O8_PROXY_URL?.trim();
  return (raw || DEFAULT_PROXY_BASE).replace(/\/+$/, '');
}

export interface InferenceRoute {
  /** Fully-formed upstream URL to POST to. */
  url: string;
  /** Headers including auth (and analytics headers for the direct path). */
  headers: Record<string, string>;
  via: 'direct' | 'proxy';
}

/**
 * The plan-token bearer for the proxy — the raw EdDSA JWT from entitlement.json.
 * Returns null unless it looks like a compact JWT (3 dot-separated segments);
 * the proxy makes the real validity call.
 */
function planToken(): string | null {
  const token = readCachedEntitlement()?.licenseKey?.trim();
  return token && token.split('.').length === 3 ? token : null;
}

function resolveGeminiKey(): string | undefined {
  return (
    process.env.GOOGLE_AI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GEMINI_API_KEY
  );
}

/**
 * OpenRouter chat-completions route. Direct (user key) → proxy (plan token) →
 * null. The proxy is OpenRouter-compatible, so the request body is identical
 * either way; only the URL + auth header change.
 */
export async function resolveOpenRouterRoute(): Promise<InferenceRoute | null> {
  const localKey = await resolveOpenRouterKey();
  if (localKey) {
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localKey}`,
        // OpenRouter analytics — harmless if dropped, omitted on the proxy path.
        'HTTP-Referer': 'https://o8.run',
        'X-Title': 'o8 Cortex Q&A',
      },
      via: 'direct',
    };
  }

  const token = planToken();
  if (token) {
    return {
      url: `${proxyBaseUrl()}/v1/inference`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      via: 'proxy',
    };
  }

  return null;
}

/**
 * Gemini embeddings route for `embedContent`. Direct (local Gemini key, key in
 * the query string) → proxy (plan token, Bearer) → null. The request BODY
 * differs by path (the direct Gemini API wants `content.parts`, the proxy wants
 * `{ text }`), so the caller branches on `via` — see gemini-embed.ts.
 */
export function resolveEmbedRoute(model: string): InferenceRoute | null {
  const localKey = resolveGeminiKey();
  if (localKey) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${localKey}`,
      headers: { 'Content-Type': 'application/json' },
      via: 'direct',
    };
  }

  const token = planToken();
  if (token) {
    return {
      url: `${proxyBaseUrl()}/v1/embeddings`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      via: 'proxy',
    };
  }

  return null;
}
