import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two dependencies so we can drive every branch deterministically.
vi.mock('@/lib/cortex/qa/llm/byok-keys', () => ({
  resolveOpenRouterKey: vi.fn(),
}));
vi.mock('@/lib/entitlement/license', () => ({
  readCachedEntitlement: vi.fn(),
}));

import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';
import { readCachedEntitlement } from '@/lib/entitlement/license';
import { resolveEmbedRoute, resolveOpenRouterRoute } from '@/lib/cortex/qa/llm/inference-route';

const mockKey = vi.mocked(resolveOpenRouterKey);
const mockEnt = vi.mocked(readCachedEntitlement);

describe('inference-route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.O8_PROXY_URL;
  });

  describe('resolveOpenRouterRoute', () => {
    it('routes DIRECT when a local OpenRouter key is present', async () => {
      mockKey.mockResolvedValue('sk-local-key');
      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('direct');
      expect(route?.url).toContain('openrouter.ai');
      expect(route?.headers.Authorization).toBe('Bearer sk-local-key');
    });

    it('routes to PROXY when no local key but a plan token exists', async () => {
      mockKey.mockResolvedValue(null);
      mockEnt.mockReturnValue({ plan: 'pro', licenseKey: 'aaa.bbb.ccc' });
      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('proxy');
      expect(route?.url).toContain('/v1/inference');
      expect(route?.headers.Authorization).toBe('Bearer aaa.bbb.ccc');
      // No OpenRouter analytics headers on the proxy path.
      expect(route?.headers['HTTP-Referer']).toBeUndefined();
    });

    it('returns null when there is neither a key nor a token', async () => {
      mockKey.mockResolvedValue(null);
      mockEnt.mockReturnValue(null);
      expect(await resolveOpenRouterRoute()).toBeNull();
    });

    it('local key WINS over a plan token (founder never hits the proxy)', async () => {
      mockKey.mockResolvedValue('sk-local-key');
      mockEnt.mockReturnValue({ plan: 'pro', licenseKey: 'aaa.bbb.ccc' });
      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('direct');
    });

    it('ignores a malformed plan token (not a 3-part JWT)', async () => {
      mockKey.mockResolvedValue(null);
      mockEnt.mockReturnValue({ plan: 'pro', licenseKey: 'not-a-jwt' });
      expect(await resolveOpenRouterRoute()).toBeNull();
    });

    it('respects the O8_PROXY_URL override (trailing slash trimmed)', async () => {
      process.env.O8_PROXY_URL = 'https://proxy.example.com/';
      mockKey.mockResolvedValue(null);
      mockEnt.mockReturnValue({ plan: 'pro', licenseKey: 'a.b.c' });
      const route = await resolveOpenRouterRoute();
      expect(route?.url).toBe('https://proxy.example.com/v1/inference');
    });
  });

  describe('resolveEmbedRoute', () => {
    it('routes DIRECT with a local Gemini key (key in the query string)', () => {
      process.env.GEMINI_API_KEY = 'g-local';
      mockEnt.mockReturnValue(null);
      const route = resolveEmbedRoute('gemini-embedding-001');
      expect(route?.via).toBe('direct');
      expect(route?.url).toContain('generativelanguage.googleapis.com');
      expect(route?.url).toContain('gemini-embedding-001:embedContent');
      expect(route?.url).toContain('key=g-local');
    });

    it('routes to PROXY (Bearer) when no Gemini key but a plan token exists', () => {
      mockEnt.mockReturnValue({ plan: 'pro', licenseKey: 'a.b.c' });
      const route = resolveEmbedRoute('gemini-embedding-001');
      expect(route?.via).toBe('proxy');
      expect(route?.url).toContain('/v1/embeddings');
      expect(route?.headers.Authorization).toBe('Bearer a.b.c');
    });

    it('returns null when neither a Gemini key nor a token is present', () => {
      mockEnt.mockReturnValue(null);
      expect(resolveEmbedRoute('gemini-embedding-001')).toBeNull();
    });
  });
});
