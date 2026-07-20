import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

const authMock = vi.hoisted(() => {
  class MockDispatchPreflightError extends Error {
    public readonly code = 'dispatch_cli_auth_unavailable';

    constructor(public readonly status: {
      house: 'codex' | 'claude' | 'opencode';
      runtime: 'codex' | 'claude-code' | 'opencode';
      installed: boolean;
      authenticated: boolean;
      detail: string;
      fix: string;
      checkedAt: number;
    }) {
      super(status.detail);
      this.name = 'DispatchPreflightError';
    }
  }
  return {
    unauthRuntime: null as OrchestratorRuntime | null,
    DispatchPreflightError: MockDispatchPreflightError,
  };
});

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  DispatchPreflightError: authMock.DispatchPreflightError,
  assertRuntimeDispatchable: vi.fn(async (runtime: OrchestratorRuntime) => {
    if (runtime !== authMock.unauthRuntime) return;
    throw new authMock.DispatchPreflightError({
      house: 'opencode',
      runtime: 'opencode',
      installed: true,
      authenticated: false,
      detail: 'opencode needs auth.json at /test-home/.local/share/opencode/auth.json.',
      fix: 'Run `opencode auth login` to create auth.json.',
      checkedAt: Date.now(),
    });
  }),
}));

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-create-mission-runtimes-'));
const repoPath = path.join(dataDir, 'repo');
execFileSync('git', ['init', '-q', repoPath]);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const createMissionRoute = await import('@/app/api/orchestrator/create-mission/route');
const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { MISSION_TOOLS } = await import('@/lib/mcp/operator-handlers/mission');

function request(runtime: OrchestratorRuntime, issueNumber: number): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/create-mission', {
    method: 'POST',
    headers: { host: 'localhost:3001' },
    body: JSON.stringify({
      repoPath,
      requestedRuntime: runtime,
      issues: [{
        number: issueNumber,
        title: `${runtime} dispatch real-path seam`,
        body: `Prove ${runtime} survives the create_mission path.`,
        url: '',
      }],
    }),
  });
}

afterEach(() => {
  authMock.unauthRuntime = null;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('create_mission runtime reachability', () => {
  it.each([
    ['claude-code', 91_598_001],
    ['gemini', 91_598_002],
    ['opencode', 91_598_003],
    ['cursor', 91_598_004],
    ['grok', 91_598_005],
    ['pi', 91_598_006],
  ] as const)('%s remains selected through the real route and persisted mission', async (runtime, issueNumber) => {
    const response = await createMissionRoute.POST(request(runtime, issueNumber));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true });

    const packet = readOrchestratorControlPlaneState().packets[0];
    expect(packet?.runtime).toBe(runtime);
    expect(packet?.workerRouting?.requestedRuntime).toBe(runtime);
    expect(packet?.workerRouting?.selectedRuntime).toBe(runtime);
    expect(packet?.workerRouting?.selectedProvider).toBe(runtime === 'claude-code' ? 'claude' : runtime);
    expect(packet?.workerRouting?.enforcement).toBe('dispatchable_runtimes');
  });

  it('publishes OpenCode and Pi in the create_mission runtime enum', () => {
    const createMission = MISSION_TOOLS.find((tool) => tool.name === 'create_mission');
    const properties = createMission?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
    expect(properties?.runtime?.enum).toEqual(expect.arrayContaining(['opencode', 'pi']));
  });

  it('returns a clean missing-credential response when OpenCode auth.json is absent', async () => {
    authMock.unauthRuntime = 'opencode';
    const beforeMissionId = readOrchestratorControlPlaneState().missionId;

    const response = await createMissionRoute.POST(request('opencode', 91_598_007));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: false,
      error: { code: 'dispatch_cli_auth_unavailable' },
    });
    expect(payload.error.message).toContain('opencode needs auth.json');
    expect(payload.error.message).toContain('opencode auth login');
    expect(readOrchestratorControlPlaneState().missionId).toBe(beforeMissionId);
  });
});
