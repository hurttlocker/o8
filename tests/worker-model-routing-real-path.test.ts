import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketStorageAdmissionCoordinator } from '@/lib/orchestrator/storage-admission';

const testCacheRoot = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(testCacheRoot, { recursive: true });
const dataDir = mkdtempSync(join(testCacheRoot, 'o8-worker-model-route-'));
const argsPath = join(dataDir, 'codex-args.jsonl');
const fakeCodexPath = join(dataDir, 'fake-codex');

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(dataDir, 'owned-codex');
process.env.O8_CODEX_BIN = fakeCodexPath;
process.env.O8_TEST_CODEX_ARGS_FILE = argsPath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_WORKER_SANDBOX = '0';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

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

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

function makeRepo(): string {
  const repoPath = mkdtempSync(join(dataDir, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'worker model routing test\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

function packetFixture(
  repoPath: string,
  id: string,
  overrides: Partial<OrchestratorPacket> = {},
): OrchestratorPacket {
  return {
    id,
    referenceLabel: id.toUpperCase(),
    title: `packet ${id}`,
    summary: `packet ${id}`,
    status: 'queued',
    queueState: 'queued',
    releaseState: 'pending',
    runtime: 'codex',
    wave: 1,
    dependencyPacketIds: [],
    blockedReason: null,
    lane: null,
    review: null,
    workspaceTargetPath: repoPath,
    branchTarget: `fix/${id}`,
    ...overrides,
  } as OrchestratorPacket;
}

function storageAdmission(): PacketStorageAdmissionCoordinator {
  return {
    reserveForLaunch: async (packet) => {
      const recordedAt = Date.now();
      const receipt = {
        schema: 'o8/packet-storage-admission/v1' as const,
        state: 'reserved' as const,
        reason: 'test admission',
        reservationId: `packet-storage:${packet.id}:1`,
        mutationId: `packet-storage-reserve:${packet.id}:1`,
        ownerId: packet.id,
        ownerGeneration: 1,
        estimateBytes: 2_147_483_648,
        estimateSource: 'source-size-fallback' as const,
        historySamples: 0,
        volumeId: 'device:test',
        physicalAvailableBytes: 40_000_000_000,
        reservedBeforeBytes: 0,
        requiredReserveBytes: 10_000_000_000,
        dispatchHeadroomBytes: 30_000_000_000,
        recordedAt,
      };
      return {
        receipt,
        reservation: {
          reservationId: receipt.reservationId,
          volumeId: receipt.volumeId,
          targetPath: packet.workspaceTargetPath!,
          exactBytes: receipt.estimateBytes,
          ownerId: packet.id,
          ownerGeneration: 1,
          generation: 1,
          state: 'reserved' as const,
          leaseExpiresAt: recordedAt + 60_000,
          preMeasurement: {
            status: 'observed' as const,
            targetPath: packet.workspaceTargetPath!,
            probePath: '/',
            volumeId: receipt.volumeId,
            availableBytes: 40_000_000_000,
            freeBytes: 40_000_000_000,
            totalBytes: 100_000_000_000,
            observedAt: recordedAt,
            error: null,
          },
          postMeasurement: null,
          lastMutationId: receipt.mutationId,
          lastReason: receipt.reason,
          createdAt: recordedAt,
          updatedAt: recordedAt,
          terminalAt: null,
        },
        baselineWorkspacePaths: [],
      };
    },
    commitAfterLaunch: async (lease) => ({
      ...lease.receipt,
      state: 'committed' as const,
      reason: 'committed',
    }),
    settleFailedLaunch: async (_packet, lease) => ({
      ...lease.receipt,
      state: 'released' as const,
      reason: 'released',
    }),
  };
}

function readArgvCalls(): string[][] {
  if (!existsSync(argsPath)) return [];
  return readFileSync(argsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function waitForArgvCalls(count: number): Promise<string[][]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const calls = readArgvCalls();
    if (calls.length >= count) return calls;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} Codex launches.`);
}

beforeAll(() => {
const fixture = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.145.0\\n');
  process.exit(0);
}
appendFileSync(process.env.O8_TEST_CODEX_ARGS_FILE, JSON.stringify(args) + '\\n');
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0 && args[outputIndex + 1]) {
  writeFileSync(args[outputIndex + 1], 'Configured Brain answer.');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'worker-' + process.pid }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
`;
  writeFileSync(fakeCodexPath, fixture, 'utf8');
  chmodSync(fakeCodexPath, 0o755);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('worker model routing real path', () => {
  it('keeps worker defaults, packet pins, and Brain routing on their configured values', async () => {
    const { POST } = await import('@/app/api/panel/operator-defaults/route');
    const response = await POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriptionProfile: 'both',
        parallelCap: 2,
        defaultDispatchRuntime: 'codex',
        defaultDispatchModel: 'gpt-5.6-sol',
        codexWorkerEffort: 'high',
        brainCodexModel: 'gpt-5.6-terra',
        brainCodexEffort: 'xhigh',
      }),
    }));
    expect(response.status).toBe(200);

    const defaultRepoPath = makeRepo();
    const pinnedRepoPath = makeRepo();
    const { resolveWorkerRouting } = await import('@/lib/agents/routing');
    const pinnedRouting = resolveWorkerRouting({
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.5',
      source: 'worker-model-real-path-test',
    });
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const defaultState: OrchestratorMissionState = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-default-worker-model-route',
      repoPath: defaultRepoPath,
      packets: [packetFixture(defaultRepoPath, 'default-worker')],
    };
    const pinnedState: OrchestratorMissionState = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-pinned-worker-model-route',
      repoPath: pinnedRepoPath,
      packets: [packetFixture(pinnedRepoPath, 'pinned-worker', {
        assignedModel: 'gpt-5.5',
        workerRouting: pinnedRouting,
      })],
    };
    const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
    const dispatchedDefault = await runDispatchTick(defaultState, { storageAdmission: storageAdmission() });
    const dispatchedPinned = await runDispatchTick(pinnedState, { storageAdmission: storageAdmission() });

    const workerCalls = (await waitForArgvCalls(2)).filter((args) => args.includes('--json'));
    expect(workerCalls).toHaveLength(2);
    const defaultCall = workerCalls.find((args) => args.some((arg) => arg.includes('packet default-worker')));
    const pinnedCall = workerCalls.find((args) => args.some((arg) => arg.includes('packet pinned-worker')));
    expect(defaultCall).toBeDefined();
    expect(defaultCall?.[defaultCall.indexOf('--model') + 1]).toBe('gpt-5.6-sol');
    expect(defaultCall).toContain('model_reasoning_effort=high');
    expect(pinnedCall).toBeDefined();
    expect(pinnedCall?.[pinnedCall.indexOf('--model') + 1]).toBe('gpt-5.5');
    expect(pinnedCall).toContain('model_reasoning_effort=high');

    expect(dispatchedDefault.packets.find((packet) => packet.id === 'default-worker')).toMatchObject({
      assignedModel: 'gpt-5.6-sol',
      workerRouting: {
        selectedModel: 'gpt-5.6-sol',
        selectedEffort: 'high',
      },
    });
    expect(dispatchedPinned.packets.find((packet) => packet.id === 'pinned-worker')).toMatchObject({
      assignedModel: 'gpt-5.5',
      workerRouting: {
        selectedModel: 'gpt-5.5',
        selectedEffort: 'high',
      },
    });

    const { callCodex, resetCodexProviderCache } = await import('@/lib/cortex/qa/llm/codex-adapter');
    resetCodexProviderCache();
    await expect(callCodex('Which Brain route is active?')).resolves.toBe('Configured Brain answer.');
    const allCalls = await waitForArgvCalls(3);
    const brainCall = allCalls.find((args) => args.includes('--output-last-message'));
    expect(brainCall).toBeDefined();
    expect(brainCall?.[brainCall.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
    expect(brainCall).toContain('model_reasoning_effort=xhigh');

    const codexOnlyResponse = await POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriptionProfile: 'codex-only',
        defaultDispatchModel: '',
      }),
    }));
    expect(codexOnlyResponse.status).toBe(200);
    const codexOnlyRepoPath = makeRepo();
    const codexOnlyState: OrchestratorMissionState = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-codex-only-worker-model-route',
      repoPath: codexOnlyRepoPath,
      packets: [packetFixture(codexOnlyRepoPath, 'codex-only-worker')],
    };
    const dispatchedCodexOnly = await runDispatchTick(codexOnlyState, {
      storageAdmission: storageAdmission(),
    });
    const codexOnlyCall = (await waitForArgvCalls(4))
      .find((args) => args.some((arg) => arg.includes('packet codex-only-worker')));
    expect(codexOnlyCall?.[codexOnlyCall.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
    expect(dispatchedCodexOnly.packets[0]).toMatchObject({
      assignedModel: 'gpt-5.6-terra',
      workerRouting: { selectedModel: 'gpt-5.6-terra', selectedEffort: 'high' },
    });
  }, 30_000);
});
