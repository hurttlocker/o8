/**
 * Targeting/legacy no-op effort dispatch (#2519 correction).
 *
 * `POST /api/panel/targets/dispatch` passes a tier's effort to Gemini/OpenCode
 * tiers where it is a documented per-runtime no-op, calling `createMission`
 * directly (bypassing the strict create-mission route). This proves that path
 * still DISPATCHES: the persisted effort is recorded, `selectedEffort` stays
 * null, and a real lane/session is created through the scheduler + launch
 * boundary. The strict public route rejects an explicit unsupported pin before
 * any side effect separately (mission-effort-pin-real-path.test.ts).
 *
 * Only the process/provider boundary (spawn, auth preflight, worktree prep,
 * readiness probes) and the supervisor fetch are mocked, matching the proven
 * dispatch-mission-runtime-override harness.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const testDataDir = mkdtempSync(join(os.tmpdir(), 'o8-mission-effort-noop-'));
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
    ensureDispatchBackendReady: vi.fn(async (runtimeId: string, mode: string) => (
      actual.ensureDispatchBackendReady(runtimeId, mode)
    )),
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
  writeFileSync(join(repoPath, 'README.md'), 'mission effort no-op test\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
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

describe('targeting/legacy no-op effort dispatch', () => {
  it('dispatches a runtime without a reasoning surface while recording the no-op effort', async () => {
    spawnMock.mockReturnValue({ pid: 9_999_999, stdin: null, unref: vi.fn(), once: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    const repoPath = createTempRepo();
    const { createMission, dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { findLaneByPacket } = await import('@/lib/lane/registry');

    // Exactly what POST /api/panel/targets/dispatch does for an OpenCode tier.
    const created = await createMission({
      issues: [{
        number: 900_201,
        title: 'targeting no-op effort',
        body: 'Point an agent at the targeted file.',
        url: '',
      }],
      repoPath,
      runtime: 'opencode',
      requestedRuntime: 'opencode',
      requestedEffort: 'low',
      constraints: '',
      dispatchOnCreate: true,
    });
    const packetId = created.packets[0]?.id as string;
    const packet = readOrchestratorControlPlaneState().packets.find((p) => p.id === packetId);
    expect(packet?.workerRouting).toMatchObject({
      requestedEffort: 'low',
      selectedEffort: null,
    });

    // The launch guard must NOT block a documented no-op: a real lane/session appears.
    await dispatchMission({ missionId: created.missionId });
    await waitUntil(() => Boolean(findLaneByPacket(packetId)?.sessionKey));
    expect(findLaneByPacket(packetId)).toMatchObject({
      runtime: 'opencode',
      sessionKey: expect.stringMatching(/^opencode-owned:/),
    });
    expect(spawnMock).toHaveBeenCalled();
  }, 30_000);
});
