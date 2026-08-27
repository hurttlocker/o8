import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { MODEL_IDS } from '@/lib/models';
import { serializeOperatorDefaultsToml } from '@/lib/settings/toml';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-runtime-inventory-route-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const availability = [{
  id: 'claude-code',
  label: 'Claude Code',
  available: false,
  unavailableReason: 'needs_auth',
  detail: 'Claude Code CLI is installed but not signed in.',
  fix: 'Run `claude` once to sign in.',
}];

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: vi.fn(async () => ({
    statuses: {},
    suggestedSubscriptionProfile: { profile: null, detail: null },
  })),
  getDispatchableRuntimeAvailability: vi.fn(async () => availability),
}));

const operatorDefaultsRoute = await import('@/app/api/panel/operator-defaults/route');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('operator-defaults dispatchable runtime inventory', () => {
  it('exposes runtime id, label, and structured availability through the existing read route', async () => {
    const response = await operatorDefaultsRoute.GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      dispatchableRuntimes: availability,
      roleRoutes: [
        { id: 'orchestrate' },
        { id: 'build' },
        { id: 'review' },
        { id: 'brain' },
        { id: 'triage' },
        { id: 'recovery' },
      ],
      recentRoleReceipts: expect.any(Array),
    });
  });

  it('rejects an incompatible worker runtime and model before persistence', async () => {
    const response = await operatorDefaultsRoute.POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultDispatchRuntime: 'codex',
        defaultDispatchModel: MODEL_IDS.orchestratorDefault,
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('not compatible with Codex'),
    });

    const persisted = await operatorDefaultsRoute.GET();
    await expect(persisted.json()).resolves.toMatchObject({
      values: { defaultDispatchModel: '' },
    });
  });

  it('applies the same compatibility guard to direct settings.toml saves', async () => {
    const before = await operatorDefaultsRoute.GET();
    const payload = await before.json();
    const response = await operatorDefaultsRoute.POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settingsToml: serializeOperatorDefaultsToml({
          ...payload.values,
          defaultDispatchRuntime: 'codex',
          defaultDispatchModel: MODEL_IDS.orchestratorDefault,
        }),
        settingsTomlRevision: payload.settingsToml.revision,
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('not compatible with Codex'),
    });
  });

  it('names the subscription profile as the source of constrained routes', async () => {
    const response = await operatorDefaultsRoute.POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionProfile: 'codex-only' }),
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      sources: {
        orchestratorBackend: 'profile',
        defaultDispatchRuntime: 'profile',
        reviewerBackend: 'profile',
      },
    });
    expect(payload.roleRoutes.find((item: { id: string }) => item.id === 'orchestrate')).toMatchObject({
      sources: { backend: 'profile' },
    });
    expect(payload.roleRoutes.find((item: { id: string }) => item.id === 'build')).toMatchObject({
      sources: { runtime: 'profile' },
    });
    expect(payload.roleRoutes.find((item: { id: string }) => item.id === 'review')).toMatchObject({
      sources: { backend: 'profile' },
    });

    const restore = await operatorDefaultsRoute.POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionProfile: 'both' }),
    }));
    expect(restore.status).toBe(200);
  });
});
