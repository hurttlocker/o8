import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

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
    });
  });
});
