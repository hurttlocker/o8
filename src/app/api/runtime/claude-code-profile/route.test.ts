import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requirePanelAuthMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: requirePanelAuthMock }));
vi.mock('@/lib/claude-code/codex-subscription-proxy', () => ({
  getCodexSubscriptionProxyStatus: async () => ({
    installed: true,
    authenticated: false,
    running: false,
    connecting: false,
    modelCount: 0,
  }),
}));

describe('PATCH /api/runtime/claude-code-profile', () => {
  let dataDir: string;
  let priorDataDir: string | undefined;
  let priorLegacyDataDir: string | undefined;

  beforeEach(() => {
    priorDataDir = process.env.O8_DATA_DIR;
    priorLegacyDataDir = process.env.CORTEX_IDE_DATA_DIR;
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-claude-profile-route-'));
    process.env.O8_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    requirePanelAuthMock.mockReset().mockReturnValue(null);
    vi.resetModules();
  });

  afterEach(() => {
    if (priorDataDir === undefined) delete process.env.O8_DATA_DIR;
    else process.env.O8_DATA_DIR = priorDataDir;
    if (priorLegacyDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
    else process.env.CORTEX_IDE_DATA_DIR = priorLegacyDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function patch(body: unknown) {
    const route = await import('./route');
    return route.PATCH(new NextRequest('http://127.0.0.1/api/runtime/claude-code-profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  async function post(body: unknown) {
    const route = await import('./route');
    return route.POST(new NextRequest('http://127.0.0.1/api/runtime/claude-code-profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  it('persists only the repository skill allowlist and preserves connection settings', async () => {
    const profile = await import('@/lib/claude-code/worker-profile');
    await profile.writeClaudeCodeWorkerProfile({
      source: 'openrouter',
      model: 'deepseek/deepseek-v4-pro-0813',
      codexModel: 'gpt-5.6-sol',
      repoSkillAllowlist: ['old-skill'],
    });

    const response = await patch({ repoSkillAllowlist: ['review-only', 'security_audit'] });

    expect(response.status).toBe(200);
    expect(profile.readClaudeCodeWorkerProfileSync()).toEqual({
      source: 'openrouter',
      model: 'deepseek/deepseek-v4-pro-0813',
      codexModel: 'gpt-5.6-sol',
      repoSkillAllowlist: ['review-only', 'security_audit'],
    });
  });

  it('requires panel authorization before reading the patch body', async () => {
    requirePanelAuthMock.mockReturnValue(NextResponse.json({ ok: false }, { status: 401 }));

    const response = await patch({ repoSkillAllowlist: ['review-only'] });

    expect(response.status).toBe(401);
    expect(requirePanelAuthMock).toHaveBeenCalledOnce();
  });

  it('rejects unrelated fields without changing the persisted profile', async () => {
    const profile = await import('@/lib/claude-code/worker-profile');
    const original = {
      source: 'native' as const,
      model: null,
      codexModel: null,
      repoSkillAllowlist: ['review-only'],
    };
    await profile.writeClaudeCodeWorkerProfile(original);

    const response = await patch({ repoSkillAllowlist: ['replacement'], source: 'codex-subscription' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: 'invalid_fields',
        message: 'Only repoSkillAllowlist can be changed by this action.',
      },
    });
    expect(profile.readClaudeCodeWorkerProfileSync()).toEqual(original);
  });

  it('preserves the latest skill allowlist when a connection update omits it', async () => {
    const profile = await import('@/lib/claude-code/worker-profile');
    await profile.writeClaudeCodeWorkerProfile({
      source: 'native',
      model: null,
      codexModel: 'gpt-5.6-sol',
      repoSkillAllowlist: ['old-skill'],
    });
    const skillUpdate = await patch({ repoSkillAllowlist: ['review-only'] });
    expect(skillUpdate.status).toBe(200);

    const response = await post({
      source: 'codex-subscription',
      model: null,
      codexModel: 'gpt-6-astra',
    });

    expect(response.status).toBe(200);
    expect(profile.readClaudeCodeWorkerProfileSync()).toEqual({
      source: 'codex-subscription',
      model: null,
      codexModel: 'gpt-6-astra',
      repoSkillAllowlist: ['review-only'],
    });
  });

  it('bounds and validates repository skill names', async () => {
    const oversized = await patch({
      repoSkillAllowlist: Array.from({ length: 9 }, (_, index) => `skill-${index}`),
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: { code: 'repo_skill_limit_exceeded' } });

    const malformed = await patch({ repoSkillAllowlist: ['../escape'] });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'invalid_repo_skill_name' } });
  });
});
