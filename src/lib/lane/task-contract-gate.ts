import type { PacketTaskContract, PacketTaskContractSource } from '@/lib/orchestrator/types';
import type { PacketDeviations } from '@/lib/orchestrator/packet-deviations';
import type { Lane } from '@/lib/lane/types';

const DEFAULT_CONTRACT_MISSING_REASON = 'The runtime-default task contract was not captured from the worker transcript.';

export async function resolveTaskContractCoverageRequirement(input: {
  laneId: string;
  runtime: string;
  contractRequired: boolean;
  contractSource?: PacketTaskContractSource;
  contract?: PacketTaskContract | null;
}): Promise<boolean> {
  if (!input.contractRequired) return false;
  if (input.contractSource !== 'default' || input.contract) return true;

  try {
    const { appendEvent, getLaneEvents } = await import('@/lib/lane/registry');
    const alreadyRecorded = getLaneEvents(input.laneId, 1_000)
      .some((event) => event.verb === 'task_contract_missing');
    if (!alreadyRecorded) {
      appendEvent(input.laneId, 'task_contract_missing', 'system', {
        runtime: input.runtime,
        reason: DEFAULT_CONTRACT_MISSING_REASON,
      });
    }
  } catch (error) {
    console.warn(
      `[task-contract] failed to record missing default contract for lane ${input.laneId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return false;
}

export async function resolvePacketTaskContractGate(input: {
  lane: Pick<Lane, 'id' | 'packetId' | 'runtime'>;
  completionContext?: { taskContract?: PacketTaskContract } | null;
  deviations?: PacketDeviations | null;
}): Promise<{ taskContract: PacketTaskContract | null; enforceCoverage: boolean; packetFound: boolean }> {
  const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const packet = readOrchestratorControlPlaneState().packets
    .find((candidate) => candidate.id === input.lane.packetId);
  const taskContract = input.completionContext?.taskContract ?? packet?.taskContract ?? null;
  const enforceCoverage = await resolveTaskContractCoverageRequirement({
    laneId: input.lane.id,
    runtime: packet?.runtime ?? input.lane.runtime,
    contractRequired: packet?.taskContractRequired === true,
    contractSource: packet?.taskContractSource,
    contract: taskContract,
  });
  if (input.lane.packetId && 'deviations' in input) {
    const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
    await patchMissionPacket(input.lane.packetId, {
      deviations: input.deviations ?? null,
      taskContract,
    });
  }
  return { taskContract, enforceCoverage, packetFound: Boolean(packet) };
}
