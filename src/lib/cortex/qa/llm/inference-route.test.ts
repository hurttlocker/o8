import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two dependencies so we can drive every branch deterministically.
vi.mock('@/lib/cortex/qa/llm/byok-keys', () => ({
  resolveOpenRouterKey: vi.fn(),
}));
vi.mock('@/lib/entitlement/license', () => ({
  readCachedEntitlement: vi.fn(),
}));
vi.mock('@/lib/operator/defaults', () => ({
  resolveLocalInferenceBaseUrlSync: vi.fn(),
  resolveLocalChatModelSync: vi.fn(),
}));

import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';
import { readCachedEntitlement } from '@/lib/entitlement/license';
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
const mockLocalBaseUrl = vi.mocked(resolveLocalInferenceBaseUrlSync);
const mockLocalChatModel = vi.mocked(resolveLocalChatModelSync);

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

    it('routes plan-token users to PROXY before a local OpenRouter key', async () => {
      mockKey.mockResolvedValue('sk-local-key');
      mockEnt.mockReturnValue({ plan: 'pro', licenseKey: 'aaa.bbb.ccc' });
      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('proxy');
      expect(route?.url).toContain('/v1/inference');
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

    it('routes LOCAL when a free user has a configured live local endpoint', async () => {
      mockKey.mockResolvedValue(null);
      mockEnt.mockReturnValue(null);
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
    });

    it('falls through to DIRECT when configured local is dead', async () => {
      mockKey.mockResolvedValue('sk-local-key');
      mockEnt.mockReturnValue(null);
      mockLocalBaseUrl.mockReturnValue('http://localhost:11434');
      mockLocalChatModel.mockReturnValue('qwen2.5-coder:7b');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const route = await resolveOpenRouterRoute();
      expect(route?.via).toBe('direct');
      expect(route?.headers.Authorization).toBe('Bearer sk-local-key');
    });

    it('returns null instead of LOCAL when configured local is dead and no BYO key exists', async () => {
      mockKey.mockResolvedValue(null);
      mockEnt.mockReturnValue(null);
      mockLocalBaseUrl.mockReturnValue('http://localhost:11434');
      mockLocalChatModel.mockReturnValue('qwen2.5-coder:7b');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(503, { error: 'down' })));

      expect(await resolveOpenRouterRoute()).toBeNull();
    });

    it('routes plan-token founders to PROXY, not LOCAL, even when local is configured and alive', async () => {
      mockKey.mockResolvedValue(null);
      mockEnt.mockReturnValue({ plan: 'founder', licenseKey: 'aaa.bbb.ccc' });
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
