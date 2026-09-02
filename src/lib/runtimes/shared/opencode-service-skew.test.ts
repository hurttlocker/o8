import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authFixture = vi.hoisted(() => ({
  home: '',
}));

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
  scanAndLink: vi.fn((binaryName: string) => (
    binaryName === 'opencode2' ? '/test-bin/opencode2' : null
  )),
}));

authFixture.home = mkdtempSync(path.join(os.tmpdir(), 'o8-opencode-service-skew-home-'));
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-opencode-service-skew-data-'));
const repoPath = path.join(dataDir, 'repo');
execFileSync('git', ['init', '-q', repoPath]);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const {
  probeOpencodeServiceVersion,
  setOpencodeServiceProbeDependenciesForTests,
} = await import('./opencode-readiness');
const {
  getRuntimeAuthSnapshot,
  invalidateRuntimeAuthCache,
} = await import('./auth-detect');
const operatorDefaultsRoute = await import('@/app/api/panel/operator-defaults/route');
const createMissionRoute = await import('@/app/api/orchestrator/create-mission/route');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');

function createMissionRequest(): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/create-mission', {
    method: 'POST',
    headers: { host: 'localhost:3001' },
    body: JSON.stringify({
      clientMutationId: 'create-opencode-service-skew',
      repoPath,
      requestedRuntime: 'opencode',
      requestedModel: 'opencode/deepseek-v4-flash-free',
      issues: [{
        number: 91_798_001,
        title: 'OpenCode resident service version skew',
        body: 'Refuse dispatch until the resident service matches the CLI.',
        url: '',
      }],
    }),
  });
}

function serviceRun(serviceVersion: () => string) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === '--version') return 'opencode2 v0.0.0-beta-17794\n';
    if (args[0] === 'service') return 'http://127.0.0.1:41779\n';
    if (args[0] === 'api') {
      return JSON.stringify({
        healthy: true,
        version: serviceVersion(),
        pid: 41779,
      });
    }
    throw new Error(`Unexpected OpenCode probe: ${args.join(' ')}`);
  });
}

beforeEach(() => {
  vi.stubEnv('XDG_CONFIG_HOME', path.join(authFixture.home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(authFixture.home, '.local', 'share'));
  vi.stubEnv('APPDATA', '');
  vi.stubEnv('LOCALAPPDATA', '');
  vi.stubEnv('OPENCODE_CONFIG_DIR', '');
  vi.stubEnv('OPENCODE_CONFIG', '');
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', '');
  vi.stubEnv('OPENCODE_AUTH_CONTENT', '');
  setOpencodeServiceProbeDependenciesForTests(null);
  invalidateRuntimeAuthCache();
});

afterEach(() => {
  setOpencodeServiceProbeDependenciesForTests(null);
  invalidateRuntimeAuthCache();
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(authFixture.home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('OpenCode resident service version readiness', () => {
  it('compares the CLI version with the authenticated service health version', async () => {
    const run = serviceRun(() => '0.0.0-beta-17793');

    await expect(probeOpencodeServiceVersion('/test-bin/opencode2', { run })).resolves.toEqual({
      state: 'version_skew',
      cliVersion: '0.0.0-beta-17794',
      serviceVersion: '0.0.0-beta-17793',
    });
    expect(run).toHaveBeenNthCalledWith(1, ['--version']);
    expect(run).toHaveBeenNthCalledWith(2, ['service', 'status']);
    expect(run).toHaveBeenNthCalledWith(3, ['api', 'get', '/api/health']);
  });

  it('requires a restart when a running service cannot answer the authenticated health probe', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === '--version') return 'opencode2 v0.0.0-beta-17794\n';
      if (args[0] === 'service') return 'http://127.0.0.1:41779\n';
      throw new Error('UnsupportedContentType');
    });

    await expect(probeOpencodeServiceVersion('/test-bin/opencode2', { run })).resolves.toEqual({
      state: 'incompatible',
      cliVersion: '0.0.0-beta-17794',
      serviceVersion: null,
    });
  });

  it('refreshes cached readiness, marks the real route unavailable, and refuses create_mission without mutating persisted state', async () => {
    let residentVersion = '0.0.0-beta-17794';
    const run = serviceRun(() => residentVersion);
    setOpencodeServiceProbeDependenciesForTests({ run });
    invalidateRuntimeAuthCache();

    const readyResponse = await operatorDefaultsRoute.GET();
    expect(readyResponse.status).toBe(200);
    await expect(readyResponse.json()).resolves.toMatchObject({
      dispatchableRuntimes: expect.arrayContaining([
        expect.objectContaining({
          id: 'opencode',
          available: true,
          unavailableReason: null,
        }),
      ]),
    });
    writeOrchestratorControlPlaneState(readOrchestratorControlPlaneState());
    const controlPlanePath = path.join(dataDir, 'orchestrator-state.json');
    const beforePersistedState = readFileSync(controlPlanePath, 'utf8');

    residentVersion = '0.0.0-beta-17793';
    // The OpenCode probe is now throttled to a 10s TTL (see auth-detect.ts) even while the
    // outer 60s auth-snapshot cache is fresh, so force a fresh probe the same way an operator
    // manually re-checking readiness after a restart would.
    invalidateRuntimeAuthCache();
    const readinessResponse = await operatorDefaultsRoute.GET();
    expect(readinessResponse.status).toBe(200);
    await expect(readinessResponse.json()).resolves.toMatchObject({
      cliAuth: {
        statuses: {
          opencode: {
            installed: true,
            ready: false,
            unavailableReason: 'needs_restart',
          },
        },
      },
      dispatchableRuntimes: expect.arrayContaining([
        expect.objectContaining({
          id: 'opencode',
          available: false,
          unavailableReason: 'needs_restart',
        }),
      ]),
    });

    const response = await createMissionRoute.POST(createMissionRequest());
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: false,
      error: { code: 'dispatch_cli_auth_unavailable' },
    });
    expect(payload.error.message).toContain('0.0.0-beta-17794');
    expect(payload.error.message).toContain('0.0.0-beta-17793');
    expect(payload.error.message).toContain('opencode2 service restart');
    expect(readFileSync(controlPlanePath, 'utf8')).toBe(beforePersistedState);
  });

  it('throttles the OpenCode probe to a 10s TTL independent of the 60s auth-snapshot cache', async () => {
    const run = serviceRun(() => '0.0.0-beta-17794');
    setOpencodeServiceProbeDependenciesForTests({ run });
    invalidateRuntimeAuthCache();

    // Seed the main auth-snapshot cache under real timers first (same path every other test in
    // this file exercises), so we only enter fake-timer territory for the OpenCode-specific
    // throttle itself and never risk a mocked clock stalling an unrelated real timeout.
    await getRuntimeAuthSnapshot();
    expect(run).toHaveBeenCalledTimes(3);

    try {
      vi.useFakeTimers({ now: Date.now() });

      await getRuntimeAuthSnapshot();
      await getRuntimeAuthSnapshot();
      expect(run).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(10_001);
      await getRuntimeAuthSnapshot();
      expect(run).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a cache-hit OpenCode refresh invalidated while its probe is in flight', async () => {
    const initialRun = serviceRun(() => '0.0.0-beta-17794');
    setOpencodeServiceProbeDependenciesForTests({ run: initialRun });
    invalidateRuntimeAuthCache();
    await getRuntimeAuthSnapshot();

    let releaseOldProbe!: () => void;
    let markOldProbeStarted!: () => void;
    const oldProbeStarted = new Promise<void>((resolve) => { markOldProbeStarted = resolve; });
    const oldProbeGate = new Promise<void>((resolve) => { releaseOldProbe = resolve; });
    let apiCalls = 0;
    const raceRun = vi.fn(async (args: string[]) => {
      if (args[0] === '--version') {
        if (raceRun.mock.calls.length === 1) {
          markOldProbeStarted();
          await oldProbeGate;
        }
        return 'opencode2 v0.0.0-beta-17794\n';
      }
      if (args[0] === 'service') return 'http://127.0.0.1:41779\n';
      if (args[0] === 'api') {
        apiCalls += 1;
        return JSON.stringify({
          healthy: true,
          version: apiCalls === 1 ? '0.0.0-beta-17793' : '0.0.0-beta-17794',
          pid: 41779,
        });
      }
      throw new Error(`Unexpected OpenCode probe: ${args.join(' ')}`);
    });
    setOpencodeServiceProbeDependenciesForTests({ run: raceRun });

    try {
      vi.useFakeTimers({ now: Date.now() });
      await vi.advanceTimersByTimeAsync(10_001);
      const pending = getRuntimeAuthSnapshot();
      await oldProbeStarted;
      invalidateRuntimeAuthCache();
      releaseOldProbe();

      await expect(pending).resolves.toMatchObject({
        statuses: {
          opencode: {
            ready: true,
            unavailableReason: null,
          },
        },
      });
      expect(raceRun).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
