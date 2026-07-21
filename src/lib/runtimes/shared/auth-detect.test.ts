import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  getRuntimeCapability,
  listDeclarativeRuntimes,
  listDispatchableRuntimes,
} from '@/lib/orchestrator/runtime-capabilities';

const declarativeRuntimeIds = listDeclarativeRuntimes();

const authFixture = vi.hoisted(() => ({ home: '', installed: new Set(['opencode']) }));
const scanAndLinkMock = vi.hoisted(() => vi.fn((binaryName: string) => (
  authFixture.installed.has(binaryName) ? `/test-bin/${binaryName}` : null
)));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => authFixture.home,
    },
  };
});

vi.mock('./cli-locate', () => ({
  scanAndLink: scanAndLinkMock,
}));

authFixture.home = mkdtempSync(path.join(os.tmpdir(), 'o8-opencode-auth-'));

const {
  assertRuntimeDispatchable,
  getDispatchableRuntimeAvailability,
  getRuntimeAuthSnapshot,
  invalidateRuntimeAuthCache,
} = await import('./auth-detect');

afterEach(() => {
  vi.unstubAllEnvs();
  authFixture.installed = new Set(['opencode']);
  invalidateRuntimeAuthCache();
});

afterAll(() => {
  rmSync(authFixture.home, { recursive: true, force: true });
});

describe('OpenCode auth preflight', () => {
  it('reports the missing auth.json path without throwing', async () => {
    invalidateRuntimeAuthCache();
    const snapshot = await getRuntimeAuthSnapshot();
    const status = snapshot.statuses.opencode;

    expect(status).toMatchObject({
      installed: true,
      authenticated: false,
      runtime: 'opencode',
    });
    expect(status.detail).toBe(
      `opencode needs auth.json at ${path.join(authFixture.home, '.local', 'share', 'opencode', 'auth.json')}.`,
    );
    expect(status.fix).toContain('opencode auth login');
  });
});

describe('dispatchable runtime readiness', () => {
  it('marks every declarative worker available when its PATH and credential probes pass', async () => {
    authFixture.installed = new Set([
      'opencode',
      ...declarativeRuntimeIds.map((runtime) => getRuntimeCapability(runtime).binaryName),
    ]);
    for (const runtime of declarativeRuntimeIds) {
      const envName = getRuntimeCapability(runtime).declarative?.authEnvVars[0];
      if (!envName) throw new Error(`missing auth env probe for ${runtime}`);
      vi.stubEnv(envName, `test-${runtime}`);
    }
    invalidateRuntimeAuthCache();

    const inventory = await getDispatchableRuntimeAvailability();
    for (const runtime of declarativeRuntimeIds) {
      expect(inventory.find((entry) => entry.id === runtime)).toMatchObject({
        available: true,
        unavailableReason: null,
      });
    }
  });

  it.each(declarativeRuntimeIds)(
    'returns a structured not-installed reason for %s when its PATH probe misses',
    async (runtime) => {
      authFixture.installed.delete(getRuntimeCapability(runtime).binaryName);
      invalidateRuntimeAuthCache();

      await expect(assertRuntimeDispatchable(runtime)).rejects.toMatchObject({
        code: 'dispatch_cli_auth_unavailable',
        status: {
          runtime,
          installed: false,
          unavailableReason: 'not_installed',
        },
      });
    },
  );

  it('returns a structured not-installed reason for a registered Pi adapter', async () => {
    vi.stubEnv('O8_PI_BIN', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', '');
    invalidateRuntimeAuthCache();

    await expect(assertRuntimeDispatchable('pi')).rejects.toMatchObject({
      code: 'dispatch_cli_auth_unavailable',
      status: {
        runtime: 'pi',
        installed: false,
        unavailableReason: 'not_installed',
      },
    });
  });

  it('publishes every launch-capable adapter with availability truth', async () => {
    const inventory = await getDispatchableRuntimeAvailability();
    expect(inventory.map((entry) => entry.id)).toEqual(listDispatchableRuntimes());
    expect(inventory.every((entry) => entry.label.length > 0)).toBe(true);
    expect(inventory.find((entry) => entry.id === 'pi')).toMatchObject({
      available: false,
      unavailableReason: 'not_installed',
    });
  });
});
