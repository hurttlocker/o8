import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { listDeclarativeRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session';

const authMock = vi.hoisted(() => {
  class MockDispatchPreflightError extends Error {
    public readonly code = 'dispatch_cli_auth_unavailable';

    constructor(public readonly status: {
      house: string;
      runtime: OrchestratorRuntime;
      installed: boolean;
      authenticated: boolean;
      unavailableReason: 'not_installed' | 'needs_auth';
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
    const needsAuth = runtime === 'opencode';
    throw new authMock.DispatchPreflightError({
      house: runtime,
      runtime,
      installed: needsAuth,
      authenticated: false,
      unavailableReason: needsAuth ? 'needs_auth' : 'not_installed',
      detail: needsAuth
        ? 'OpenCode 2 needs auth.json at /test-home/.local/share/opencode/auth.json.'
        : `${runtime} CLI is not installed.`,
      fix: needsAuth
        ? 'Run `opencode2 auth login` to create auth.json.'
        : `Install ${runtime} and configure credentials.`,
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
await import('@/lib/runtimes/declarative-workers');
const { getDeclarativeOwnedRuntime } = await import('@/lib/runtimes/shared/owned-session');
const { getCostParser } = await import('@/lib/runtimes/shared/cost-parser-registry');

const NEW_RUNTIMES = listDeclarativeRuntimes();

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
    ['openhands', 91_598_011],
    ['goose', 91_598_012],
    ['qwen', 91_598_013],
    ['kimi', 91_598_014],
    ['aider', 91_598_015],
    ['qoder', 91_598_016],
  ] as const)('%s remains selected through the real route and persisted mission', async (runtime, issueNumber) => {
    const response = await createMissionRoute.POST(request(runtime, issueNumber));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true });

    const packet = readOrchestratorControlPlaneState().packets.find((entry) => entry.title.includes(runtime));
    expect(packet?.runtime).toBe(runtime);
    expect(packet?.workerRouting?.requestedRuntime).toBe(runtime);
    expect(packet?.workerRouting?.selectedRuntime).toBe(runtime);
    expect(packet?.workerRouting?.selectedProvider).toBe(runtime === 'claude-code' ? 'claude' : runtime);
    expect(packet?.workerRouting?.enforcement).toBe('dispatchable_runtimes');
  });

  it('publishes declarative runtimes in the create_mission runtime enum', () => {
    const createMission = MISSION_TOOLS.find((tool) => tool.name === 'create_mission');
    const properties = createMission?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
    expect(properties?.runtime?.enum).toEqual(expect.arrayContaining(['opencode', 'pi', ...NEW_RUNTIMES]));
  });

  it('persists transient outside-launch provenance on the packet', async () => {
    const response = await createMissionRoute.POST(new NextRequest('http://localhost:3001/api/orchestrator/create-mission', {
      method: 'POST',
      headers: { host: 'localhost:3001' },
      body: JSON.stringify({
        repoPath,
        requestedRuntime: 'codex',
        issues: [{
          number: 91_598_008,
          title: 'outside launch context seam',
          body: 'Keep this repo temporary and reveal the worker in its own pane.',
          url: '',
        }],
        launchContext: {
          source: 'cli',
          presentation: 'split',
          repoContext: 'transient',
          caller: 'outside terminal',
        },
      }),
    }));
    expect(response.status).toBe(201);
    const packet = readOrchestratorControlPlaneState().packets.find((entry) => entry.title === 'outside launch context seam');
    expect(packet?.launchContext).toEqual({
      source: 'cli',
      presentation: 'split',
      repoContext: 'transient',
      caller: 'outside terminal',
    });
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
    expect(payload.error.message).toContain('OpenCode 2 needs auth.json');
    expect(payload.error.message).toContain('opencode2 auth login');
    expect(readOrchestratorControlPlaneState().missionId).toBe(beforeMissionId);
  });

  it.each(NEW_RUNTIMES)('returns a structured unavailable response when %s is absent', async (runtime) => {
    authMock.unauthRuntime = runtime;
    const beforeMissionId = readOrchestratorControlPlaneState().missionId;

    const response = await createMissionRoute.POST(request(runtime, 91_598_020 + NEW_RUNTIMES.indexOf(runtime)));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: false,
      error: { code: 'dispatch_cli_auth_unavailable' },
    });
    expect(payload.error.message).toContain(`${runtime} CLI is not installed`);
    expect(payload.error.message).toContain(`Install ${runtime}`);
    expect(readOrchestratorControlPlaneState().missionId).toBe(beforeMissionId);
  });

  it('renders valid launch specs from every declarative config entry', () => {
    const launchSpecs = Object.fromEntries(NEW_RUNTIMES.map((runtime) => [
      runtime,
      getDeclarativeOwnedRuntime(runtime)?.adapter.launchArgs({
        cwd: repoPath,
        prompt: 'fix the bug',
      }),
    ]));

    expect(launchSpecs).toEqual({
      openhands: ['--headless', '--json', '-t', 'fix the bug'],
      goose: ['run', '-t', 'fix the bug', '--max-turns', '100'],
      qwen: ['-p', 'fix the bug', '--yolo', '--output-format', 'stream-json'],
      qoder: ['-p', 'fix the bug', '-m', 'Qwen3.8-Max-Preview', '--dangerously-skip-permissions', '--output-format', 'stream-json'],
      kimi: ['-p', 'fix the bug'],
      aider: ['--message', 'fix the bug', '--yes-always', '--auto-test'],
    });
  });

  it('normalizes structured and text output without runtime-specific parsers', async () => {
    const run: OwnedRunRecord = {
      id: 'declarative-run-1',
      mode: 'launch',
      prompt: 'fix the bug',
      startedAt: '2026-07-19T00:00:00.000Z',
      finishedAt: '2026-07-19T00:00:01.000Z',
      pid: 123,
      stdoutPath: '/tmp/declarative.stdout.log',
      stderrPath: '/tmp/declarative.stderr.log',
      outcome: 'running',
    };
    const openHands = getDeclarativeOwnedRuntime('openhands')?.adapter.parseRunLog([
      JSON.stringify({ type: 'assistant_message', content: 'done' }),
      JSON.stringify({ type: 'completed', message: 'complete' }),
    ].join('\n'), run);
    const qwen = getDeclarativeOwnedRuntime('qwen')?.adapter.parseRunLog([
      JSON.stringify({ type: 'message', content: 'done' }),
      JSON.stringify({ type: 'result', usage: { outputTokens: 2 } }),
    ].join('\n'), run);

    expect(openHands).toMatchObject({ completedTurn: true, outcome: 'finished' });
    expect(qwen).toMatchObject({ completedTurn: true, outcome: 'finished' });
    expect(openHands?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'done' })]));
    expect(qwen?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'done' })]));

    const gooseCost = await getCostParser('goose')?.parseLines?.(['plain text output']);
    expect(gooseCost).toMatchObject({ inputTokens: 0, outputTokens: 5, totalCostUsd: 0 });
  });
});
