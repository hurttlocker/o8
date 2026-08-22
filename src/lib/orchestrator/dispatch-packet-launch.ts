import 'server-only';

import { resolveClaudeCodeWorkerSelection, selectedClaudeCodeWorkerModelSync } from '@/lib/claude-code/worker-profile';
import { listSessionRuleTexts } from '@/lib/db/session-rules-store';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { recordLaneEvent } from '@/lib/lane/events';
import { getOperatorDefaultsSync, resolveOpencodeWorkerModelSync } from '@/lib/operator/defaults';
import type { PacketSpendCap } from './metered-spend';
import { getProjectContext } from '@/lib/projects/context';
import { resolveDefaultBranch } from '@/lib/repos/registry';
import { assertRuntimeDispatchable } from '@/lib/runtimes/shared/auth-detect';
import type {
  OrchestratorPacket,
  OrchestratorRuntime,
  WorkerRouting,
} from './types';
import { getRuntimeCapability } from './runtime-capabilities';
import { bindWorkerLaunchParent } from './worker-launch-context';
import { buildPacketPrompt } from './packet-prompt';
import { withIdempotency } from './idempotency-store';
import {
  PacketStorageAdmissionError,
  type PacketStorageAdmissionCoordinator,
  type PacketStorageAdmissionReceipt,
} from './storage-admission';
import { findExactCommittedLaunch } from './storage-admission-generation';

export interface LaunchPacketResult {
  laneId: string;
  sessionKey: string | null;
  workerRouting: WorkerRouting;
  storageAdmission: PacketStorageAdmissionReceipt;
  spendCap?: PacketSpendCap;
  dependencyMaterializationMode: 'native' | 'image' | null;
}

function resolvePacketSpendCap(packet: OrchestratorPacket, runtime: OrchestratorRuntime): PacketSpendCap | undefined {
  if (packet.spendCap) return packet.spendCap;
  if (runtime !== 'claude-code') return undefined;
  const selection = resolveClaudeCodeWorkerSelection({ carrier: packet.claudeCodeCarrier, model: packet.claudeCodeModel });
  if (selection.source !== 'openrouter') return undefined;
  const defaults = getOperatorDefaultsSync().values;
  return {
    carrier: 'openrouter',
    costUsd: defaults.meteredPacketCostCapUsd,
    inputTokens: defaults.meteredPacketInputTokenCap,
  };
}

function operatorWorkerModelFor(runtime: OrchestratorRuntime): string | null {
  if (runtime === 'claude-code') {
    try {
      return selectedClaudeCodeWorkerModelSync();
    } catch {
      return null;
    }
  }
  if (runtime !== 'opencode') return null;
  try {
    return resolveOpencodeWorkerModelSync();
  } catch {
    return null;
  }
}

export async function launchPacketWithStorageAdmission(input: {
  packet: OrchestratorPacket;
  allPackets: OrchestratorPacket[];
  workerRouting: WorkerRouting;
  storageAdmission: PacketStorageAdmissionCoordinator;
}): Promise<LaunchPacketResult> {
  const { packet, allPackets, workerRouting, storageAdmission } = input;
  const spendCap = resolvePacketSpendCap(packet, workerRouting.selectedRuntime);
  const launchContext = bindWorkerLaunchParent(packet.launchContext, {
    threadId: packet.orchestratorThreadId,
  });
  const projectContext = await getProjectContext({ repoPath: packet.workspaceTargetPath });
  const baseBranch = await resolveDefaultBranch(packet.workspaceTargetPath!);
  await assertRuntimeDispatchable(
    workerRouting.selectedRuntime,
    workerRouting.selectedModel,
    packet.workspaceTargetPath,
  );
  const admissionLease = await storageAdmission.reserveForLaunch(packet);
  const launchGeneration = admissionLease.receipt.ownerGeneration;
  if (
    admissionLease.receipt.state === 'committed'
    || admissionLease.reservation.state === 'committed'
  ) {
    const lane = await findExactCommittedLaunch(packet, launchGeneration, workerRouting);
    if (!lane) {
      throw new PacketStorageAdmissionError(
        'Dispatch held because a committed launch could not be reconstructed from its exact active lane.',
        {
          ...admissionLease.receipt,
          state: 'held',
          reason: 'launch_effect_unknown',
        },
      );
    }
    return {
      laneId: lane.id,
      sessionKey: lane.sessionKey,
      workerRouting,
      storageAdmission: admissionLease.receipt,
      spendCap,
      dependencyMaterializationMode: packet.lane?.dependencyMaterializationMode ?? null,
    };
  }
  const claimKey = `packet-storage-launch:${admissionLease.receipt.reservationId}`;
  const outcome = await withIdempotency<LaunchPacketResult>({
    key: claimKey,
    verb: 'packet_storage_launch',
    scopeId: packet.id,
    reconcileUnresolved: async () => {
      const lane = await findExactCommittedLaunch(packet, launchGeneration, workerRouting);
      if (!lane) return null;
      return {
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        workerRouting,
        storageAdmission: await storageAdmission.commitAfterLaunch(admissionLease),
        spendCap,
        dependencyMaterializationMode: packet.lane?.dependencyMaterializationMode ?? null,
      };
    },
  }, async () => {
    let laneResult: Awaited<ReturnType<typeof dispatchLaneCommand>>;
    let launchResult: Awaited<ReturnType<typeof dispatchLaneCommand>>;
    try {
      laneResult = await dispatchLaneCommand({
        verb: 'open_lane',
        packetId: packet.id,
        repoPath: packet.workspaceTargetPath!,
        projectId: projectContext.runtimeProjectId,
        branch: packet.branchTarget,
        baseBranch,
        runtime: workerRouting.selectedRuntime,
        label: packet.title,
        actor: 'orchestrator',
      });
      if (!laneResult.ok || !laneResult.laneId) throw new Error(laneResult.note || 'Unable to open lane.');
      launchResult = await dispatchLaneCommand({
        verb: 'launch_session',
        laneId: laneResult.laneId,
        prompt: await buildPacketPrompt(
          packet,
          allPackets,
          laneResult.lane?.baseBranch ?? baseBranch,
          laneResult.lane?.worktreePath ?? null,
        ),
        model: (
          workerRouting.selectedModel
          ?? operatorWorkerModelFor(workerRouting.selectedRuntime)
          ?? getRuntimeCapability(workerRouting.selectedRuntime).defaultModel
        ) ?? undefined,
        claudeCodeModel: packet.claudeCodeModel ?? undefined,
        claudeCodeCarrier: packet.claudeCodeCarrier ?? undefined,
        spendCap,
        effort: workerRouting.selectedEffort ?? undefined,
        clientMutationId: `packet-launch:${packet.id}:${launchGeneration}`,
        storageAdmissionReservationId: admissionLease.receipt.reservationId,
        launchContext,
        actor: 'orchestrator',
      });
      if (!launchResult.ok) throw new Error(launchResult.note || 'Unable to launch session.');
    } catch (error) {
      const receipt = await storageAdmission.settleFailedLaunch(packet, admissionLease);
      throw new PacketStorageAdmissionError(
        error instanceof Error ? error.message : 'Unable to launch session.',
        receipt,
      );
    }

    const storageReceipt = await storageAdmission.commitAfterLaunch(admissionLease);
    if (packet.orchestratorThreadId) {
      try {
        const rules = listSessionRuleTexts(packet.orchestratorThreadId);
        if (rules.length > 0) {
          recordLaneEvent(laneResult.laneId, 'rules_applied', 'orchestrator', {
            threadId: packet.orchestratorThreadId,
            ruleCount: rules.length,
            rules,
          });
        }
      } catch (error) {
        console.warn('[session-rules] failed to record rules_applied event', error);
      }
    }
    return {
      laneId: laneResult.laneId,
      sessionKey: launchResult.lane?.sessionKey ?? null,
      workerRouting,
      storageAdmission: storageReceipt,
      spendCap,
      dependencyMaterializationMode: launchResult.dependencyMaterializationMode ?? null,
    };
  });
  if (!outcome.inProgress) return outcome.result;
  throw new PacketStorageAdmissionError(
    outcome.unresolved
      ? 'Dispatch held because the prior launch owner ended before its result was reconciled.'
      : 'Dispatch held because this exact packet generation is already launching.',
    {
      ...admissionLease.receipt,
      state: 'held',
      reason: outcome.unresolved ? 'launch_effect_unknown' : 'launch_in_progress',
    },
  );
}
