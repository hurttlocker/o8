import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-profile-route-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const profileRoute = await import('@/app/api/runtime/claude-code-profile/route');
const modelsRoute = await import('@/app/api/runtime/claude-code-models/route');
const codexRoute = await import('@/app/api/runtime/claude-code-codex/route');

function request(pathname: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(`http://localhost:3001${pathname}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${getOrCreateWsToken()}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Claude Code worker settings through production routes', () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    rmSync(path.join(dataDir, 'claude-code-worker.json'), { force: true });
    vi.unstubAllGlobals();
  });

  it('rejects unauthenticated profile reads', async () => {
    const response = await profileRoute.GET(new NextRequest('http://localhost:3001/api/runtime/claude-code-profile'));
    expect(response.status).toBe(401);
  });

  it('persists a gateway choice and reports the separate billing boundary', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-route-test';
    const response = await profileRoute.POST(request('/api/runtime/claude-code-profile', {
      method: 'POST',
      body: { source: 'openrouter', model: 'x-ai/grok-4.6', codexModel: null },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      profile: { source: 'openrouter', model: 'x-ai/grok-4.6', codexModel: null },
      effectiveModel: 'x-ai/grok-4.6',
      openrouterConfigured: true,
      billing: 'api',
      codexSubscriptionSupported: true,
    });
    const stored = readFileSync(path.join(dataDir, 'claude-code-worker.json'), 'utf8');
    expect(stored).toContain('x-ai/grok-4.6');
    expect(stored).not.toContain('sk-or-route-test');
  });

  it('rejects an API-billed carrier selection when no key is configured', async () => {
    const response = await profileRoute.POST(request('/api/runtime/claude-code-profile', {
      method: 'POST',
      body: { source: 'openrouter', model: 'provider/frontier-model', codexModel: null },
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Configure an API key'),
    });
    expect(existsSync(path.join(dataDir, 'claude-code-worker.json'))).toBe(false);
  });

  it('serves only tool-capable live models to the harness picker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: [
        { id: 'deepseek/deepseek-v4-pro-0813', name: 'DeepSeek: V4 Pro', supported_parameters: ['tools', 'tool_choice'] },
        { id: 'x-ai/grok-4.6', name: 'SpaceXAI: Grok 4.6', supported_parameters: ['tools', 'tool_choice'] },
        { id: 'text-only/model', name: 'Text only', supported_parameters: ['temperature'] },
      ],
    })));

    const response = await modelsRoute.GET(request('/api/runtime/claude-code-models?refresh=1'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(JSON.stringify(body.groups)).toContain('deepseek/deepseek-v4-pro-0813');
    expect(JSON.stringify(body.groups)).toContain('x-ai/grok-4.6');
    expect(JSON.stringify(body.groups)).not.toContain('text-only/model');
  });

  it('keeps discovered Codex OAuth credentials owner-only through the authenticated route', async () => {
    const authDir = path.join(dataDir, 'cliproxy', 'codex-auth');
    const credentialPath = path.join(authDir, 'codex-test.json');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(credentialPath, JSON.stringify({ type: 'codex', access_token: 'route-test-only' }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(credentialPath, 0o644);

    const response = await codexRoute.GET(request('/api/runtime/claude-code-codex'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: { authenticated: true },
    });
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
  });
});
