import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

const counterPath = process.env.O8_TEST_LAUNCH_COUNTER;
const gatePath = process.env.O8_TEST_LAUNCH_GATE;
const resultPath = process.env.O8_TEST_LAUNCH_RESULT;

vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: vi.fn(async (input: { packetId?: string; repoPath: string }) => {
    appendFileSync(counterPath!, `${process.pid}\n`);
    while (!existsSync(gatePath!)) await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ok: true,
      surfaceId: `codex-owned:${input.packetId}`,
      note: 'fixture launch',
      worktree: { path: input.repoPath },
    };
  }),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

const enabled = Boolean(counterPath && gatePath && resultPath && process.env.O8_TEST_LAUNCH_REPO);

describe.skipIf(!enabled)('cross-process packet launch child', () => {
  it('runs or observes the durable production launch claim', async () => {
    const repoPath = process.env.O8_TEST_LAUNCH_REPO!;
    const { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const { launchPacketWithStorageAdmission } = await import('@/lib/orchestrator/dispatch-packet-launch');
    const { resolveWorkerRouting } = await import('@/lib/agents/routing');
    const packet = normalizeOrchestratorMissionState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-cross-process-launch',
      repoPath,
      packets: [{
        id: 'cross-process-launch', title: 'cross process launch', summary: 'cross process launch',
        status: 'queued', queueState: 'queued', releaseState: 'pending', runtime: 'codex',
        wave: 1, dependencyPacketIds: [], workspaceTargetPath: repoPath,
        branchTarget: 'inline/cross-process-launch',
      }],
    }).packets[0]!;
    const receipt = {
      schema: 'o8/packet-storage-admission/v1' as const,
      state: 'reserved' as const,
      reason: 'admitted',
      reservationId: 'packet-storage:cross-process-launch:1',
      mutationId: 'packet-storage-reserve:cross-process-launch:1',
      ownerId: packet.id,
      ownerGeneration: 1,
      estimateBytes: 1,
      estimateSource: 'source-size-fallback' as const,
      historySamples: 0,
      volumeId: 'device:test',
      physicalAvailableBytes: 10,
      reservedBeforeBytes: 0,
      requiredReserveBytes: 0,
      dispatchHeadroomBytes: 10,
      pressure: null,
      recordedAt: Date.now(),
    };
    const admission = {
      reserveForLaunch: async () => ({
        receipt,
        reservation: {
          reservationId: receipt.reservationId, volumeId: receipt.volumeId, targetPath: repoPath,
          exactBytes: 1, ownerId: packet.id, ownerGeneration: 1, generation: 1,
          state: 'reserved' as const, leaseExpiresAt: Date.now() + 60_000,
          preMeasurement: null as never, postMeasurement: null,
          lastMutationId: receipt.mutationId, lastReason: 'admitted',
          createdAt: Date.now(), updatedAt: Date.now(), terminalAt: null,
        },
        baselineWorkspacePaths: [],
      }),
      commitAfterLaunch: async () => ({ ...receipt, state: 'committed' as const, reason: 'committed' }),
      settleFailedLaunch: async () => ({ ...receipt, state: 'released' as const, reason: 'released' }),
    };
    try {
      await launchPacketWithStorageAdmission({
        packet,
        allPackets: [packet],
        workerRouting: resolveWorkerRouting({ requestedRuntime: 'codex', source: 'scheduler-dispatch' }),
        storageAdmission: admission,
      });
      writeFileSync(resultPath!, 'launched');
    } catch (error) {
      expect(error).toMatchObject({ receipt: { reason: 'launch_in_progress' } });
      writeFileSync(resultPath!, 'held');
    }
  }, 20_000);
});
