import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { MODEL_IDS } from '@/lib/models';
import type { LaneCommand, LaneCommandResult } from '@/lib/lane/types';

const laneCommandMock = vi.hoisted(() => vi.fn());
const runtimeDispatchableMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/lib/panel/auth', () => ({
  requirePanelAuth: vi.fn(() => null),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: runtimeDispatchableMock,
}));

vi.mock('@/lib/orchestrator/operator-mission-service/branch-cleanup', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/orchestrator/operator-mission-service/branch-cleanup')>(),
  prepareMissionBranches: vi.fn(async () => []),
}));

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => undefined),
}));

vi.mock('@/lib/lane/commands', () => ({
  dispatch: laneCommandMock,
}));

vi.mock('@/lib/orchestrator/storage-pressure-policy', () => ({
  getStoragePressureAdmissionCoordinator: () => ({
    reserveForLaunch: async (packet: { id: string }) => {
      const recordedAt = Date.now();
      const receipt = {
        schema: 'o8/packet-storage-admission/v1' as const,
        state: 'reserved' as const,
        reason: 'test_admitted',
        reservationId: `ui-edit-launch:${packet.id}`,
        mutationId: `ui-edit-launch:${packet.id}`,
        ownerId: packet.id,
        ownerGeneration: 1,
        estimateBytes: 1,
        estimateSource: 'source-size-fallback' as const,
        historySamples: 0,
        volumeId: 'test-volume',
        physicalAvailableBytes: 1_000_000,
        reservedBeforeBytes: 0,
        requiredReserveBytes: 1,
        dispatchHeadroomBytes: 999_999,
        pressure: null,
        recordedAt,
      };
      return { receipt, reservation: { state: 'reserved' as const }, baselineWorkspacePaths: [] };
    },
    commitAfterLaunch: async (lease: { receipt: Record<string, unknown> }) => ({
      ...lease.receipt,
      state: 'committed' as const,
    }),
    settleFailedLaunch: async (_packet: unknown, lease: { receipt: Record<string, unknown> }) => ({
      ...lease.receipt,
      state: 'held' as const,
    }),
  }),
}));

vi.mock('@/lib/projects/context', () => ({
  getProjectContext: vi.fn(async () => ({ runtimeProjectId: 'ui-edit-runtime-preset-test' })),
}));

vi.mock('@/lib/repos/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/repos/registry')>(),
  resolveDefaultBranch: vi.fn(async () => 'main'),
}));

vi.mock('@/lib/orchestrator/packet-prompt', () => ({
  buildPacketPrompt: vi.fn(async () => 'Apply the bounded UI element edit.'),
}));

vi.mock('@/lib/lane/repo-preflight', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/lane/repo-preflight')>(),
  isGitWorkTreeSync: vi.fn(() => true),
}));

vi.mock('@/lib/worktree/metadata-lock-process-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree/metadata-lock-process-identity')>();
  const identity = {
    version: 1 as const,
    platform: 'win32' as const,
    bootId: 'ui-edit-runtime-preset-test-boot',
    startId: 'ui-edit-runtime-preset-test-process',
  };
  return {
    ...actual,
    probeMetadataLockProcessIdentity: vi.fn(async () => ({ state: 'live' as const, identity })),
    probeMetadataLockProcessIdentitySync: vi.fn(() => ({ state: 'live' as const, identity })),
  };
});

const controlledEnvKeys = [
  'CORTEX_IDE_DATA_DIR',
  'CORTEX_IDE_DB_PATH',
  'O8_DATA_DIR',
  'O8_DEFAULT_DISPATCH_RUNTIME',
  'O8_DISPATCH_MODEL',
  'O8_SUBSCRIPTION_PROFILE',
] as const;
const priorEnv = Object.fromEntries(controlledEnvKeys.map((key) => [key, process.env[key]]));
const testRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-ui-edit-runtime-preset-'));
const dataDir = path.join(testRoot, 'data');
const repoPath = path.join(testRoot, 'repo');
mkdirSync(dataDir, { recursive: true });
mkdirSync(repoPath, { recursive: true });
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
delete process.env.CORTEX_IDE_DB_PATH;
delete process.env.O8_DEFAULT_DISPATCH_RUNTIME;
delete process.env.O8_DISPATCH_MODEL;
delete process.env.O8_SUBSCRIPTION_PROFILE;
function writeTestOperatorDefaults(defaultDispatchModel: string) {
  writeFileSync(path.join(dataDir, 'operator-defaults.json'), JSON.stringify({
    subscriptionProfile: 'both',
    defaultDispatchRuntime: 'codex',
    defaultDispatchModel,
  }));
}
writeTestOperatorDefaults(MODEL_IDS.codexWorkerDefault);

const { NextRequest } = await import('next/server');
const { POST } = await import('@/app/api/orchestrator/create-mission/route');
const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');

let requestSequence = 0;

async function createAndReadPacket(input: {
  carrier?: 'openrouter';
  origin?: 'design-mode';
  requestedModel?: string;
  requestedRuntime?: 'codex' | 'claude-code';
}) {
  requestSequence += 1;
  const issueNumber = 19_040_000 + requestSequence;
  const response = await POST(new NextRequest('http://127.0.0.1:47120/api/orchestrator/create-mission', {
    method: 'POST',
    headers: { host: 'localhost:47120', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientMutationId: `ui-edit-runtime-preset-${requestSequence}`,
      repoPath,
      ...(input.carrier ? { carrier: input.carrier } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
      ...(input.requestedRuntime ? { requestedRuntime: input.requestedRuntime } : {}),
      issues: [{
        number: issueNumber,
        title: `UI edit runtime preset ${requestSequence}`,
        body: '',
        url: '',
      }],
    }),
  }));
  const payload = await response.json() as {
    ok: boolean;
    result: { packets: Array<{ id: string }> };
  };
  expect(response.status).toBe(201);
  expect(payload.ok).toBe(true);
  const packetId = payload.result.packets[0]!.id;
  return readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId);
}

async function createAndReadMixedRuntimePackets(input: { carrier?: 'openrouter' } = {}) {
  requestSequence += 1;
  const issueNumber = 19_040_000 + requestSequence * 10;
  runtimeDispatchableMock.mockClear();
  const response = await POST(new NextRequest('http://127.0.0.1:47120/api/orchestrator/create-mission', {
    method: 'POST',
    headers: { host: 'localhost:47120', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientMutationId: `ui-edit-runtime-preset-${requestSequence}`,
      repoPath,
      ...(input.carrier ? { carrier: input.carrier } : {}),
      origin: 'design-mode',
      requestedRuntime: 'codex',
      issues: [{
        number: issueNumber,
        title: 'Codex UI edit runtime preset',
        body: '',
        url: '',
      }, {
        number: issueNumber + 1,
        title: 'Claude UI edit runtime preset',
        body: '',
        url: '',
        runtime: 'claude-code',
      }],
    }),
  }));
  const payload = await response.json() as {
    ok: boolean;
    result: { packets: Array<{ id: string }> };
  };
  expect(response.status).toBe(201);
  expect(payload.ok).toBe(true);
  const packetIds = new Set(payload.result.packets.map((packet) => packet.id));
  const state = readOrchestratorControlPlaneState();
  return {
    missionId: state.missionId,
    packets: state.packets.filter((packet) => packetIds.has(packet.id)),
  };
}

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  for (const key of controlledEnvKeys) {
    const prior = priorEnv[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch (error) {
    // skeleton.db is a process-lifetime disposable cache and remains locked on
    // Windows until this isolated Vitest worker exits. Global fixture cleanup
    // reclaims the stale o8-* directory on the next test run.
    if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || process.platform !== 'win32') throw error;
  }
});

describe('UI edit runtime preset dispatch routing', () => {
  it('selects the low-latency preset unless the operator pins a model', async () => {
    const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
    laneCommandMock.mockImplementation(async (command: LaneCommand): Promise<LaneCommandResult> => {
      if (command.verb === 'open_lane') {
        const lane = createLane({
          repoPath: command.repoPath,
          projectId: command.projectId,
          branch: command.branch,
          baseBranch: command.baseBranch,
          runtime: command.runtime,
          label: command.label,
          packetId: command.packetId,
          actor: command.actor,
        });
        return { ok: true, laneId: lane.id, note: 'opened', lane };
      }
      if (command.verb === 'launch_session') {
        const lane = getLane(command.laneId);
        return {
          ok: true,
          laneId: command.laneId,
          note: 'launched',
          ...(lane ? { lane: { ...lane, sessionKey: `codex-owned:${lane.id}` } } : {}),
          dependencyMaterializationMode: null,
        };
      }
      return { ok: false, laneId: 'unknown', note: `Unexpected command ${command.verb}` };
    });

    const designDefault = await createAndReadPacket({ origin: 'design-mode' });
    expect(designDefault).toMatchObject({
      origin: 'design-mode',
      assignedModel: MODEL_IDS.codexScoutDefault,
      workerRouting: {
        selectedRuntime: 'codex',
        selectedModel: MODEL_IDS.codexScoutDefault,
      },
    });
    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
    const dispatchResult = await dispatchMission({
      missionId: readOrchestratorControlPlaneState().missionId,
    });
    expect(dispatchResult.dispatched).toBe(1);
    const launchCommand = laneCommandMock.mock.calls
      .map(([command]) => command as LaneCommand)
      .find((command) => command.verb === 'launch_session');
    expect(launchCommand).toMatchObject({
      verb: 'launch_session',
      model: MODEL_IDS.codexScoutDefault,
    });

    const designExplicit = await createAndReadPacket({
      origin: 'design-mode',
      requestedModel: MODEL_IDS.codexDefault,
    });
    expect(designExplicit).toMatchObject({
      origin: 'design-mode',
      assignedModel: MODEL_IDS.codexDefault,
      workerRouting: {
        selectedRuntime: 'codex',
        selectedModel: MODEL_IDS.codexDefault,
      },
    });

    const ordinary = await createAndReadPacket({});
    expect(ordinary).toMatchObject({
      assignedModel: MODEL_IDS.codexWorkerDefault,
      workerRouting: {
        selectedRuntime: 'codex',
        selectedModel: MODEL_IDS.codexWorkerDefault,
      },
    });
    expect(ordinary?.origin).toBeUndefined();

    const ordinaryCarrier = await createAndReadPacket({
      carrier: 'openrouter',
      requestedModel: 'gateway/model-y',
      requestedRuntime: 'claude-code',
    });
    expect(ordinaryCarrier).toMatchObject({
      claudeCodeCarrier: 'openrouter',
      claudeCodeModel: 'gateway/model-y',
      assignedModel: null,
      workerRouting: {
        requestedModel: null,
        selectedRuntime: 'claude-code',
        selectedModel: null,
      },
    });

    laneCommandMock.mockClear();
    runtimeDispatchableMock.mockClear();
    writeTestOperatorDefaults(MODEL_IDS.claudeWorkerDefault);
    const designCarrier = await createAndReadPacket({
      carrier: 'openrouter',
      origin: 'design-mode',
      requestedRuntime: 'claude-code',
    });
    expect(designCarrier).toMatchObject({
      origin: 'design-mode',
      claudeCodeCarrier: 'openrouter',
      claudeCodeModel: null,
      assignedModel: null,
      workerRouting: {
        requestedModel: null,
        selectedRuntime: 'claude-code',
        selectedModel: null,
        modelDisposition: 'runtime-default',
      },
    });
    expect(runtimeDispatchableMock).toHaveBeenCalledWith('claude-code', null, repoPath);
    const carrierDispatch = await dispatchMission({
      missionId: readOrchestratorControlPlaneState().missionId,
    });
    expect(carrierDispatch.dispatched).toBe(1);
    const carrierLaunch = laneCommandMock.mock.calls
      .map(([command]) => command as LaneCommand)
      .find((command) => command.verb === 'launch_session');
    expect(carrierLaunch).toMatchObject({
      verb: 'launch_session',
      claudeCodeCarrier: 'openrouter',
      claudeCodeModel: undefined,
    });
    expect(carrierLaunch?.model).not.toBe(MODEL_IDS.claudeHaikuQaDefault);

    const claudeDefault = await createAndReadPacket({
      origin: 'design-mode',
      requestedRuntime: 'claude-code',
    });
    expect(claudeDefault).toMatchObject({
      origin: 'design-mode',
      assignedModel: MODEL_IDS.claudeHaikuQaDefault,
      workerRouting: {
        selectedRuntime: 'claude-code',
        selectedModel: MODEL_IDS.claudeHaikuQaDefault,
      },
    });

    laneCommandMock.mockClear();
    const mixedRuntime = await createAndReadMixedRuntimePackets();
    expect(mixedRuntime.packets.map((packet) => ({
      runtime: packet.runtime,
      assignedModel: packet.assignedModel,
      selectedModel: packet.workerRouting?.selectedModel,
      modelDisposition: packet.workerRouting?.modelDisposition,
    }))).toEqual(expect.arrayContaining([{
      runtime: 'codex',
      assignedModel: MODEL_IDS.codexScoutDefault,
      selectedModel: MODEL_IDS.codexScoutDefault,
      modelDisposition: 'requested',
    }, {
      runtime: 'claude-code',
      assignedModel: MODEL_IDS.claudeHaikuQaDefault,
      selectedModel: MODEL_IDS.claudeHaikuQaDefault,
      modelDisposition: 'requested',
    }]));
    expect(runtimeDispatchableMock).toHaveBeenCalledWith('codex', MODEL_IDS.codexScoutDefault, repoPath);
    expect(runtimeDispatchableMock).toHaveBeenCalledWith('claude-code', MODEL_IDS.claudeHaikuQaDefault, repoPath);

    const mixedDispatch = await dispatchMission({ missionId: mixedRuntime.missionId });
    expect(mixedDispatch.dispatched).toBe(2);
    const mixedLaunchRouting = laneCommandMock.mock.calls
      .map(([command]) => command as LaneCommand)
      .filter((command) => command.verb === 'launch_session')
      .map((command) => ({
        runtime: getLane(command.laneId)?.runtime,
        model: command.model,
      }));
    expect(mixedLaunchRouting).toEqual(expect.arrayContaining([{
      runtime: 'codex',
      model: MODEL_IDS.codexScoutDefault,
    }, {
      runtime: 'claude-code',
      model: MODEL_IDS.claudeHaikuQaDefault,
    }]));

    laneCommandMock.mockClear();
    const mixedCarrier = await createAndReadMixedRuntimePackets({ carrier: 'openrouter' });
    expect(mixedCarrier.packets.map((packet) => ({
      runtime: packet.runtime,
      carrier: packet.claudeCodeCarrier,
      assignedModel: packet.assignedModel,
      selectedModel: packet.workerRouting?.selectedModel,
      modelDisposition: packet.workerRouting?.modelDisposition,
    }))).toEqual(expect.arrayContaining([{
      runtime: 'codex',
      carrier: null,
      assignedModel: MODEL_IDS.codexScoutDefault,
      selectedModel: MODEL_IDS.codexScoutDefault,
      modelDisposition: 'requested',
    }, {
      runtime: 'claude-code',
      carrier: 'openrouter',
      assignedModel: null,
      selectedModel: null,
      modelDisposition: 'runtime-default',
    }]));
    expect(runtimeDispatchableMock).toHaveBeenCalledWith('codex', MODEL_IDS.codexScoutDefault, repoPath);
    expect(runtimeDispatchableMock).toHaveBeenCalledWith('claude-code', null, repoPath);

    const mixedCarrierDispatch = await dispatchMission({ missionId: mixedCarrier.missionId });
    expect(mixedCarrierDispatch.dispatched).toBe(1);
    const firstMixedCarrierLaunch = laneCommandMock.mock.calls
      .map(([command]) => command as LaneCommand)
      .find((command) => command.verb === 'launch_session');
    expect(firstMixedCarrierLaunch?.model).toBe(MODEL_IDS.codexScoutDefault);
    setLaneStatus(firstMixedCarrierLaunch!.laneId, 'completed', 'system', 'test-completed');
    laneCommandMock.mockClear();
    const deferredCarrierDispatch = await dispatchMission({ missionId: mixedCarrier.missionId });
    expect(deferredCarrierDispatch.dispatched).toBe(1);
    const claudeCarrierMissionLaunch = laneCommandMock.mock.calls
      .map(([command]) => command as LaneCommand)
      .find((command) => command.verb === 'launch_session');
    expect(claudeCarrierMissionLaunch).toMatchObject({
      claudeCodeCarrier: 'openrouter',
      claudeCodeModel: undefined,
    });
    expect(claudeCarrierMissionLaunch?.model).not.toBe(MODEL_IDS.claudeHaikuQaDefault);
  });
});
