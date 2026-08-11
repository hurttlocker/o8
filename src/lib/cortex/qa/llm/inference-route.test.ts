import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two dependencies so we can drive every branch deterministically.
vi.mock('@/lib/cortex/qa/llm/byok-keys', () => ({
  resolveOpenRouterKey: vi.fn(),
}));
vi.mock('@/lib/entitlement/license', () => ({
  readCachedEntitlement: vi.fn(),
}));
vi.mock('@/lib/entitlement/bootstrap', () => ({
  ensureFreeEntitlement: vi.fn(async () => {}),
}));
// planToken() now gates the managed proxy on the RESOLVED entitlement (which
// applies the #1517 view-as clamp), not the raw file plan — so drive
// getEntitlementSync too. The `setEnt` helper keeps both mocks consistent.
vi.mock('@/lib/entitlement/store', () => ({
  getEntitlementSync: vi.fn(),
}));
vi.mock('@/lib/operator/defaults', () => ({
  resolveLocalInferenceBaseUrlSync: vi.fn(),
  resolveLocalChatModelSync: vi.fn(),
}));

import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';
import { readCachedEntitlement } from '@/lib/entitlement/license';
import { ensureFreeEntitlement } from '@/lib/entitlement/bootstrap';
import { getEntitlementSync } from '@/lib/entitlement/store';
import { resolveFlags } from '@/lib/entitlement/flags';
import type { Plan } from '@/lib/entitlement/types';
import { DEFAULT_O8_API_BASE_URL } from '@/lib/hosted-service';
import {
  resetLocalInferenceProbeCacheForTests,
  resolveEmbedRoute,
  resolveOpenRouterRoute,
} from '@/lib/cortex/qa/llm/inference-route';
import {
  resolveLocalChatModelSync,
  resolveLocalInferenceBaseUrlSync,
} from '@/lib/operator/defaults';

const mockKey = vi.mocked(resolveOpenRouterKey);
const mockEnt = vi.mocked(readCachedEntitlement);
const mockEnsureFreeEntitlement = vi.mocked(ensureFreeEntitlement);
const mockStore = vi.mocked(getEntitlementSync);
const mockLocalBaseUrl = vi.mocked(resolveLocalInferenceBaseUrlSync);
const mockLocalChatModel = vi.mocked(resolveLocalChatModelSync);

/**
 * Set the cached entitlement AND the resolved entitlement together, so the
 * managed-proxy gate (getEntitlementSync().flags['proxy.inference']) tracks the
 * mocked plan. `overridePlan` simulates the #1517 view-as clamp.
 */
function setEnt(
  ent: { plan?: Plan; licenseKey?: string } | null,
  overridePlan: Plan | null = null,
) {
  mockEnt.mockReturnValue(ent as ReturnType<typeof readCachedEntitlement>);
  const realPlan: Plan = ent?.plan ?? 'free';
  const rank: Record<Plan, number> = { free: 0, pro: 1, team: 2, founder: 3 };
  const effective: Plan = overridePlan && rank[overridePlan] < rank[realPlan] ? overridePlan : realPlan;
  mockStore.mockReturnValue({
    plan: effective,
    flags: resolveFlags(effective),
    source: 'file',
    actualPlan: realPlan,
    overrideActive: overridePlan !== null,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('inference-route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    resetLocalInferenceProbeCacheForTests();
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.O8_PROXY_URL;
    mockLocalBaseUrl.mockReturnValue('');
    mockLocalChatModel.mockReturnValue('');
    // Default: free / no token. planToken() reads getEntitlementSync(), which
    // runs before the BYO-key fallback, so every test needs a resolved state.
    setEnt(null);
  });

  describe('resolveOpenRouterRoute', () => {
    it('routes DIRECT when a local OpenRouter key is present', async () => {
      mockKey.mockResolvedValue('sk-local-key');
      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('direct');
      expect(route?.url).toContain('openrouter.ai');
      expect(route?.headers.Authorization).toBe('Bearer sk-local-key');
      expect(mockEnsureFreeEntitlement).not.toHaveBeenCalled();
    });

    it('routes to PROXY when no local key but a plan token exists', async () => {
      mockKey.mockResolvedValue(null);
      setEnt({ plan: 'pro', licenseKey: 'aaa.bbb.ccc' });
      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('proxy');
      expect(route?.url).toBe(`${DEFAULT_O8_API_BASE_URL}/v1/inference`);
      expect(route?.headers.Authorization).toBe('Bearer aaa.bbb.ccc');
      // No OpenRouter analytics headers on the proxy path.
      expect(route?.headers['HTTP-Referer']).toBeUndefined();
    });

    it('returns null when there is neither a key nor a token', async () => {
      mockKey.mockResolvedValue(null);
      setEnt(null);
      expect(await resolveOpenRouterRoute()).toBeNull();
      expect(mockEnsureFreeEntitlement).not.toHaveBeenCalled();
    });

    it('provisions the install allowance only for an explicit managed request', async () => {
      mockKey.mockResolvedValue(null);
      setEnt(null);
      mockEnsureFreeEntitlement.mockImplementationOnce(async () => {
        setEnt({ plan: 'free', licenseKey: 'fresh.install.token' });
      });

      const route = await resolveOpenRouterRoute({ provisionInstallAllowance: true });

      expect(mockEnsureFreeEntitlement).toHaveBeenCalledOnce();
      expect(route?.via).toBe('proxy');
      expect(route?.headers.Authorization).toBe('Bearer fresh.install.token');
    });

    it('routes plan-token users to PROXY before a local OpenRouter key', async () => {
      mockKey.mockResolvedValue('sk-local-key');
      setEnt({ plan: 'pro', licenseKey: 'aaa.bbb.ccc' });
      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('proxy');
      expect(route?.url).toContain('/v1/inference');
    });

    it('ignores a malformed plan token (not a 3-part JWT)', async () => {
      mockKey.mockResolvedValue(null);
      setEnt({ plan: 'pro', licenseKey: 'not-a-jwt' });
      expect(await resolveOpenRouterRoute()).toBeNull();
    });

    it('drops the managed proxy when "View as Free" downclamps a founder (#1517)', async () => {
      // Real founder + valid token, but the view-as override forces free → the
      // managed proxy is NOT used; with no local key/endpoint we return null so
      // the Brain falls through to the free CLI tiers.
      mockKey.mockResolvedValue(null);
      setEnt({ plan: 'founder', licenseKey: 'aaa.bbb.ccc' }, 'free');
      expect(await resolveOpenRouterRoute()).toBeNull();
    });

    it('respects the O8_PROXY_URL override (trailing slash trimmed)', async () => {
      process.env.O8_PROXY_URL = 'https://proxy.example.com/';
      mockKey.mockResolvedValue(null);
      setEnt({ plan: 'pro', licenseKey: 'a.b.c' });
      const route = await resolveOpenRouterRoute();
      expect(route?.url).toBe('https://proxy.example.com/v1/inference');
    });

    it('routes LOCAL when a free user has a configured live local endpoint', async () => {
      mockKey.mockResolvedValue(null);
      setEnt(null);
      mockLocalBaseUrl.mockReturnValue('http://localhost:11434/');
      mockLocalChatModel.mockReturnValue('qwen2.5-coder:7b');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
        models: [{ name: 'qwen2.5-coder:7b' }],
      }));
      vi.stubGlobal('fetch', fetchMock);

      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('local');
      expect(route?.url).toBe('http://localhost:11434/v1/chat/completions');
      expect(route?.model).toBe('qwen2.5-coder:7b');
      expect(route?.headers.Authorization).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:11434/api/tags',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(mockEnsureFreeEntitlement).not.toHaveBeenCalled();
    });

    it('falls through to DIRECT when configured local is dead', async () => {
      mockKey.mockResolvedValue('sk-local-key');
      setEnt(null);
      mockLocalBaseUrl.mockReturnValue('http://localhost:11434');
      mockLocalChatModel.mockReturnValue('qwen2.5-coder:7b');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('direct');
      expect(route?.headers.Authorization).toBe('Bearer sk-local-key');
    });

    it('returns null instead of LOCAL when configured local is dead and no BYO key exists', async () => {
      mockKey.mockResolvedValue(null);
      setEnt(null);
      mockLocalBaseUrl.mockReturnValue('http://localhost:11434');
      mockLocalChatModel.mockReturnValue('qwen2.5-coder:7b');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(503, { error: 'down' })));

      expect(await resolveOpenRouterRoute()).toBeNull();
    });

    it('routes a keyless FREE install to PROXY on its anonymous allowance token', async () => {
      // Free-without-sign-in ruling 2026-08-06: no keys, no local, no paid plan
      // — the /issue-free token rides the relay (which enforces the free-chain
      // model policy + daily cap server-side).
      mockKey.mockResolvedValue(null);
      setEnt({ plan: 'free', licenseKey: 'fff.eee.ttt' });
      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('proxy');
      expect(route?.url).toBe(`${DEFAULT_O8_API_BASE_URL}/v1/inference`);
      expect(route?.headers.Authorization).toBe('Bearer fff.eee.ttt');
    });

    it('free allowance is the LAST resort — a live local endpoint still wins', async () => {
      mockKey.mockResolvedValue(null);
      setEnt({ plan: 'free', licenseKey: 'fff.eee.ttt' });
      mockLocalBaseUrl.mockReturnValue('http://localhost:11434');
      mockLocalChatModel.mockReturnValue('qwen2.5-coder:7b');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
        models: [{ name: 'qwen2.5-coder:7b' }],
      })));

      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('local');
    });

    it('free allowance is the LAST resort — a BYO OpenRouter key still wins', async () => {
      mockKey.mockResolvedValue('sk-local-key');
      setEnt({ plan: 'free', licenseKey: 'fff.eee.ttt' });
      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('direct');
      expect(route?.headers.Authorization).toBe('Bearer sk-local-key');
    });

    it('ignores a malformed free-allowance token', async () => {
      mockKey.mockResolvedValue(null);
      setEnt({ plan: 'free', licenseKey: 'not-a-jwt' });
      expect(await resolveOpenRouterRoute()).toBeNull();
    });

    it('routes plan-token founders to PROXY, not LOCAL, even when local is configured and alive', async () => {
      mockKey.mockResolvedValue(null);
      setEnt({ plan: 'founder', licenseKey: 'aaa.bbb.ccc' });
      mockLocalBaseUrl.mockReturnValue('http://localhost:11434');
      mockLocalChatModel.mockReturnValue('qwen2.5-coder:7b');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
        models: [{ name: 'qwen2.5-coder:7b' }],
      }));
      vi.stubGlobal('fetch', fetchMock);

      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('proxy');
      expect(route?.url).toContain('/v1/inference');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('resolveEmbedRoute', () => {
    it('routes DIRECT with a local Gemini key in a header, never the URL', () => {
      process.env.GEMINI_API_KEY = 'g-local';
      setEnt(null);
      const route = resolveEmbedRoute('gemini-embedding-001');
      expect(route?.via).toBe('direct');
      expect(route?.url).toContain('generativelanguage.googleapis.com');
      expect(route?.url).toContain('gemini-embedding-001:embedContent');
      expect(route?.url).not.toContain('g-local');
      expect(route?.headers['x-goog-api-key']).toBe('g-local');
    });

    it('routes to PROXY (Bearer) when no Gemini key but a plan token exists', () => {
      setEnt({ plan: 'pro', licenseKey: 'a.b.c' });
      const route = resolveEmbedRoute('gemini-embedding-001');
      expect(route?.via).toBe('proxy');
      expect(route?.url).toContain('/v1/embeddings');
      expect(route?.headers.Authorization).toBe('Bearer a.b.c');
    });

    it('returns null when neither a Gemini key nor a token is present', () => {
      setEnt(null);
      expect(resolveEmbedRoute('gemini-embedding-001')).toBeNull();
    });
  });
});
