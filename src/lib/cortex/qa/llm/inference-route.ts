/**
 * Inference route resolver (monetization Step 2).
 *
 * Decides, for a given upstream chat-completions call, whether to use the o8
 * managed-inference PROXY, a local OpenAI-compatible endpoint, or DIRECT (the
 * user's own key):
 *
 *   1. plan token present            → proxy   (founder/paid perk: managed fast path)
 *   2. free user + local alive        → local   (Ollama/LM Studio /v1/chat/completions)
 *   3. free user + local key present  → direct  (BYO OpenRouter key)
 *   4. none                           → null    (caller falls through to CLI tiers)
 *
 * The proxy bearer is the EdDSA license JWT already persisted to entitlement.json
 * (license.ts `licenseKey`, surfaced by `readCachedEntitlement`). Server-side
 * only — reads the entitlement file + the BYOK key chain.
 */

import 'server-only';

import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';
import { ensureFreeEntitlement } from '@/lib/entitlement/bootstrap';
import { readCachedEntitlement } from '@/lib/entitlement/license';
import { getEntitlementSync } from '@/lib/entitlement/store';
import { DEFAULT_O8_API_BASE_URL } from '@/lib/hosted-service';
import {
  resolveLocalChatModelSync,
  resolveLocalInferenceBaseUrlSync,
} from '@/lib/operator/defaults';

const LOCAL_LIVENESS_TTL_MS = 30_000;
const LOCAL_LIVENESS_TIMEOUT_MS = 1_500;

/** Base URL of the hosted o8 API. Overridable. */
export function proxyBaseUrl(): string {
  const raw = process.env.O8_PROXY_URL?.trim();
  return (raw || DEFAULT_O8_API_BASE_URL).replace(/\/+$/, '');
}

export interface InferenceRoute {
  /** Fully-formed upstream URL to POST to. */
  url: string;
  /** Headers including auth (and analytics headers for the direct path). */
  headers: Record<string, string>;
  via: 'direct' | 'proxy' | 'local';
  /** Optional model override for endpoints that need local model names. */
  model?: string;
}

export interface ResolveOpenRouterRouteOptions {
  /**
   * Mint an install-scoped free allowance only after the user invokes the o8
   * managed model. Passive Brain/helpers leave this false and stay offline.
   */
  provisionInstallAllowance?: boolean;
}

/**
 * The plan-token bearer for the proxy — the raw EdDSA JWT from entitlement.json.
 * Returns null unless it looks like a compact JWT (3 dot-separated segments);
 * the proxy makes the real validity call.
 */
function planToken(): string | null {
  const entitlement = readCachedEntitlement();
  const token = entitlement?.licenseKey?.trim();
  // Gate on the RESOLVED entitlement (getEntitlementSync applies the #1517
  // view-as min-clamp) rather than the raw file plan, so "View as Free" actually
  // routes the Brain through the free tiers instead of the managed proxy. The
  // licenseKey file itself stays untouched — we simply don't USE the token while
  // the effective plan is free; clearing the override restores the fast path.
  const managedPlan = getEntitlementSync().flags['proxy.inference'] === true;
  if (!managedPlan) return null;
  return token && token.split('.').length === 3 ? token : null;
}

/**
 * The free-allowance bearer (free-without-sign-in ruling 2026-08-06): the
 * anonymous first-run token minted by /issue-free. The relay serves EVERY plan
 * on /v1/inference — free accounts are force-routed onto the $0 model chain
 * with a small daily spend cap server-side — so a fresh install reaches the o8
 * model with no sign-in and no BYO key. Only consulted as the LAST route
 * resort (after local + BYOK, so nobody's existing routing changes), and never
 * while a view-as override is active: the cached token still carries the REAL
 * plan, so using it would serve a "viewing as free" founder the paid path
 * (#1517).
 */
function freeAllowanceToken(): string | null {
  const resolved = getEntitlementSync();
  if (resolved.plan !== 'free' || resolved.overrideActive) return null;
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

export interface LocalInferenceProbeResult {
  running: boolean;
  models: string[];
}

interface CachedLocalProbe extends LocalInferenceProbeResult {
  checkedAt: number;
}

const localProbeCache = new Map<string, CachedLocalProbe>();

export function normalizeLocalInferenceBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function parseOllamaInferenceModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  const names = models
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!entry || typeof entry !== 'object') return '';
      const record = entry as { name?: unknown; model?: unknown };
      if (typeof record.name === 'string') return record.name;
      if (typeof record.model === 'string') return record.model;
      return '';
    })
    .map((name) => name.trim())
    .filter(Boolean);

  return Array.from(new Set(names));
}

function parseOpenAiInferenceModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const ids = data
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const id = (entry as { id?: unknown }).id;
      return typeof id === 'string' ? id : '';
    })
    .map((id) => id.trim())
    .filter(Boolean);

  return Array.from(new Set(ids));
}

async function probeLocalInferenceEndpoint(
  base: string,
  path: string,
  parseModels: (payload: unknown) => string[],
): Promise<LocalInferenceProbeResult | null> {
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(LOCAL_LIVENESS_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const payload = await response.json().catch(() => null);
    return { running: true, models: parseModels(payload) };
  } catch {
    return null;
  }
}

export function resetLocalInferenceProbeCacheForTests(): void {
  localProbeCache.clear();
}

export async function probeLocalInference(baseUrl: string): Promise<LocalInferenceProbeResult> {
  const base = normalizeLocalInferenceBaseUrl(baseUrl);
  if (!base) return { running: false, models: [] };

  const cached = localProbeCache.get(base);
  if (cached && Date.now() - cached.checkedAt < LOCAL_LIVENESS_TTL_MS) {
    return { running: cached.running, models: cached.models };
  }

  const result = await probeLocalInferenceEndpoint(base, '/api/tags', parseOllamaInferenceModels)
    ?? await probeLocalInferenceEndpoint(base, '/v1/models', parseOpenAiInferenceModels)
    ?? { running: false, models: [] };

  localProbeCache.set(base, { ...result, checkedAt: Date.now() });
  return result;
}

/**
 * OpenAI-compatible chat-completions route. Managed plan token wins first
 * (founder/paid users get the managed fast path). Only free users can reach
 * local, and only when the endpoint recently answered a supported model-list
 * protocol; dead endpoints are skipped so the caller can fall through to
 * BYO-key/free tiers.
 */
export async function resolveOpenRouterRoute(
  options: ResolveOpenRouterRouteOptions = {},
): Promise<InferenceRoute | null> {
  const token = planToken();
  if (token) {
    return {
      url: `${proxyBaseUrl()}/v1/inference`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      via: 'proxy',
    };
  }

  const localBaseUrl = normalizeLocalInferenceBaseUrl(resolveLocalInferenceBaseUrlSync());
  const localModel = resolveLocalChatModelSync().trim();
  if (localBaseUrl && localModel) {
    const probe = await probeLocalInference(localBaseUrl);
    if (probe.running) {
      return {
        url: `${localBaseUrl}/v1/chat/completions`,
        headers: { 'Content-Type': 'application/json' },
        via: 'local',
        model: localModel,
      };
    }
  }

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

  // Free taste-allowance: no keys, no local, no paid plan — ride the managed
  // relay with the anonymous free token (relay enforces the free-chain model
  // policy + daily cap). Provisioning happens here only when the explicit o8
  // model caller opts in through provisionInstallAllowance.
  let freeToken = freeAllowanceToken();
  if (!freeToken && options.provisionInstallAllowance) {
    await ensureFreeEntitlement();
    freeToken = freeAllowanceToken();
  }
  if (freeToken) {
    return {
      url: `${proxyBaseUrl()}/v1/inference`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freeToken}` },
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
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': localKey },
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

/**
 * Whisper transcription route (OpenRouter audio/transcriptions). Direct (the
 * user's OpenRouter key) → proxy (plan token) → null. The request body is
 * identical either way, so the caller only swaps url + headers.
 */
export async function resolveTranscribeRoute(): Promise<InferenceRoute | null> {
  const localKey = await resolveOpenRouterKey();
  if (localKey) {
    return {
      url: 'https://openrouter.ai/api/v1/audio/transcriptions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localKey}`,
        'HTTP-Referer': 'https://o8.app',
        'X-Title': 'o8 Dictation',
      },
      via: 'direct',
    };
  }

  const token = planToken();
  if (token) {
    return {
      url: `${proxyBaseUrl()}/v1/transcribe`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      via: 'proxy',
    };
  }

  return null;
}
