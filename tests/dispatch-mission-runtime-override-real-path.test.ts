import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const testDataDir = mkdtempSync(join(os.tmpdir(), 'o8-dispatch-runtime-override-'));
process.env.CORTEX_IDE_DATA_DIR = testDataDir;
process.env.O8_DATA_DIR = testDataDir;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(testDataDir, 'owned-codex');
process.env.O8_OWNED_OPENCODE_ROOT = join(testDataDir, 'owned-opencode');
process.env.O8_CODEX_BIN = process.execPath;
process.env.O8_OPENCODE_BIN = process.execPath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_WORKER_SANDBOX = '0';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const spawnMock = vi.hoisted(() => vi.fn());
const readinessProbe = vi.hoisted(() => ({
  calls: [] as Array<[string, string]>,
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}));

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

vi.mock('@/lib/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree')>();
  return {
    ...actual,
    prepareLaunchWorktree: vi.fn(async (
      options: Parameters<typeof actual.prepareLaunchWorktree>[0],
    ) => ({
      cwd: options.repoRoot,
      worktree: {
        id: `packet-${options.packetId}`,
        path: options.repoRoot,
        branch: options.branchName!,
        baseBranch: options.baseBranch ?? 'main',
        agentType: options.agentType,
        status: 'ready' as const,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        dirtyFiles: [],
        claudeManaged: false,
      },
    })),
    linkSessionToWorktree: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/workspace/materialization-guard', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/workspace/materialization-guard')>(),
  inspectOwnedWorkspaceMaterialization: vi.fn(async () => ({
    status: 'available' as const,
    source: 'no-snapshot' as const,
  })),
}));

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: vi.fn(async (runtimeId: string, mode: string) => {
      readinessProbe.calls.push([runtimeId, mode]);
      return actual.ensureDispatchBackendReady(runtimeId, mode);
    }),
  };
});

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

const tempDirs = [testDataDir];

function createTempRepo() {
  const repoPath = mkdtempSync(join(testDataDir, 'repo-'));
  tempDirs.push(repoPath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'dispatch runtime override test\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

function parseToolResult(result: {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
}) {
  const text = result.content.find((entry) => entry.type === 'text')?.text ?? '';
  return JSON.parse(text) as { dispatched?: number; replayed?: boolean };
}

async function createHeldMission(repoPath: string, issueNumber: number, title: string) {
  const { createMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
  const receipt = await createMission({
    issues: [{
      number: issueNumber,
      title,
      body: `${title} body`,
      url: `https://example.test/issues/${issueNumber}`,
    }],
    repoPath,
    runtime: 'codex',
    constraints: 'Real-path dispatch runtime override regression.',
  });
  const packetId = receipt.packets[0]?.id;
  expect(packetId).toBeTruthy();

  const { resetPacket } = await import('@/lib/orchestrator/operator-mission-service/reset');
  const reset = await resetPacket({
    packetId: packetId!,
    reason: 'prepare queued dispatch replay regression',
    clearWorktree: false,
  });
  expect(reset.reset).toBe(true);
  return { missionId: receipt.missionId, packetId: packetId! };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for dispatch test state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('dispatch_mission runtime override real path', () => {
  it('carries an explicit runtime through replay and preserves persisted routing when omitted', async () => {
    spawnMock.mockReturnValue({ pid: 9_999_999, stdin: null, unref: vi.fn(), once: vi.fn() });
    const repoPath = createTempRepo();
    const explicit = await createHeldMission(repoPath, 179401, 'explicit runtime replay');

    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ defaultDispatchRuntime: 'opencode' });
    const { getOrCreateWsToken } = await import('@/lib/ws-auth');
    const operatorToken = getOrCreateWsToken();

    const dispatchBodies: Array<Record<string, unknown>> = [];
    const replayedKeys = new Set<string>();
    let readinessGate: Promise<void> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/setup/status')) {
        if (readinessGate) await readinessGate;
        return new Response(JSON.stringify({ ready: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/supervisor/watch') || url.includes('/internal/realtime')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/orchestrator/dispatch')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        dispatchBodies.push(body);
        const { NextRequest } = await import('next/server');
        const { POST } = await import('@/app/api/orchestrator/dispatch/route');
        const response = await POST(new NextRequest(url, {
          method: init?.method ?? 'POST',
          headers: init?.headers,
          body: init?.body,
        }));
        const key = String(body.idempotencyKey ?? '');
        if (!replayedKeys.has(key)) {
          replayedKeys.add(key);
          const payload = await response.clone().text();
          return new Response(payload, {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return response;
      }
      return new Response(JSON.stringify({ ok: false, error: { message: `Unhandled test URL: ${url}` } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const { handleDispatchMission } = await import('@/lib/mcp/operator-handlers/mission');
    const explicitResult = parseToolResult(await handleDispatchMission({
      missionId: explicit.missionId,
      runtime: 'opencode',
    }));

    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { findLaneByPacket } = await import('@/lib/lane/registry');
    const explicitState = readOrchestratorControlPlaneState();
    const explicitPacket = explicitState.packets.find((packet) => packet.id === explicit.packetId);
    expect(explicitResult).toMatchObject({ dispatched: 1, replayed: true });
    expect(dispatchBodies[0]).toMatchObject({ missionId: explicit.missionId, runtime: 'opencode' });
    expect(dispatchBodies[1]).toEqual(dispatchBodies[0]);
    expect(explicitState.runtime).toBe('opencode');
    expect(explicitPacket).toMatchObject({
      runtime: 'opencode',
      dispatchRuntimePin: 'opencode',
      workerRouting: {
        requestedRuntime: 'opencode',
        selectedRuntime: 'opencode',
      },
    });
    expect(findLaneByPacket(explicit.packetId)).toMatchObject({
      runtime: 'opencode',
      sessionKey: expect.stringMatching(/^opencode-owned:/),
    });
    expect(readinessProbe.calls).toContainEqual(['opencode', 'launch']);

    const omitted = await createHeldMission(repoPath, 179402, 'omitted runtime replay');
    const omittedResult = parseToolResult(await handleDispatchMission({ missionId: omitted.missionId }));
    const omittedState = readOrchestratorControlPlaneState();
    const omittedPacket = omittedState.packets.find((packet) => packet.id === omitted.packetId);
    expect(omittedResult).toMatchObject({ dispatched: 1, replayed: true });
    expect(dispatchBodies[2]).not.toHaveProperty('runtime');
    expect(dispatchBodies[3]).toEqual(dispatchBodies[2]);
    expect(omittedState.runtime).toBe('codex');
    expect(omittedPacket).toMatchObject({
      runtime: 'codex',
      dispatchRuntimePin: 'codex',
      workerRouting: {
        requestedRuntime: 'codex',
        selectedRuntime: 'codex',
      },
    });
    expect(findLaneByPacket(omitted.packetId)).toMatchObject({
      runtime: 'codex',
      sessionKey: expect.stringMatching(/^codex-owned:/),
    });
    expect(readinessProbe.calls).toContainEqual(['codex', 'launch']);

    const asynchronous = await createHeldMission(repoPath, 179403, 'durable async runtime admission');
    let releaseReadiness!: () => void;
    readinessGate = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    const readinessCallsBefore = readinessProbe.calls.length;
    const { NextRequest } = await import('next/server');
    const { POST } = await import('@/app/api/orchestrator/dispatch/route');
    const asyncResponse = await POST(new NextRequest('http://localhost/api/orchestrator/dispatch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({
        missionId: asynchronous.missionId,
        runtime: 'opencode',
        wait: false,
        idempotencyKey: 'dispatch-runtime-override-async-admission',
      }),
    }));
    expect(asyncResponse.status).toBe(200);
    await expect(asyncResponse.json()).resolves.toMatchObject({
      ok: true,
      result: { initiated: true, async: true, missionId: asynchronous.missionId },
    });
    await waitUntil(() => readinessProbe.calls.length > readinessCallsBefore);

    const admittedState = readOrchestratorControlPlaneState();
    expect(admittedState.runtime).toBe('opencode');
    expect(admittedState.packets.find((packet) => packet.id === asynchronous.packetId)).toMatchObject({
      queueState: 'queued',
      runtime: 'opencode',
      dispatchRuntimePin: 'opencode',
      workerRouting: {
        requestedRuntime: 'opencode',
        selectedRuntime: 'opencode',
      },
    });

    readinessGate = null;
    releaseReadiness();
    await waitUntil(() => Boolean(findLaneByPacket(asynchronous.packetId)?.sessionKey));
    expect(findLaneByPacket(asynchronous.packetId)).toMatchObject({
      runtime: 'opencode',
      sessionKey: expect.stringMatching(/^opencode-owned:/),
    });
    expect(spawnMock).toHaveBeenCalled();
  }, 30_000);
});
