import { withLockedState } from '@/lib/orchestrator/control-plane';
import { withMissionHandoffBarrier } from '@/lib/orchestrator/lifecycle-mutation-lock';
import {
  findMissionRegistryEntryByPacketId,
  readMissionRegistryEntry,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import { recordTaskContractCostEvent, type PacketTaskContractCapture } from '@/lib/orchestrator/task-contract-cost';
import type { OrchestratorPacket, PacketTaskContract } from '@/lib/orchestrator/types';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import type { RuntimeId, RuntimeTelemetry, RuntimeTranscriptEntry } from '@/lib/runtimes/types';

class ArchivedTaskContractMissionError extends Error {}

function captureOwnsCurrentSession(input: {
  packetId: string;
  sessionKey: string;
  lane: Lane | null;
}): boolean {
  const laneId = input.lane?.id.trim();
  if (!laneId) return false;
  const currentLane = findLatestLaneByPacket(input.packetId);
  return currentLane?.id === laneId
    && currentLane.sessionKey === input.sessionKey;
}

function sealFirstTaskContract(
  packet: OrchestratorPacket | undefined,
  contract: PacketTaskContract,
): boolean {
  if (!packet?.taskContractRequired || packet.taskContract
    || packet.archivedAt || packet.status === 'archived') return false;
  packet.taskContract = contract;
  return true;
}

async function persistToOwningMission(input: {
  packetId: string;
  sessionKey: string;
  contract: PacketTaskContract;
  lane: Lane | null;
}): Promise<void> {
  await withMissionHandoffBarrier(async () => {
    if (!captureOwnsCurrentSession(input)) return;

    let currentMissionId = '';
    const { result: currentPacketFound } = await withLockedState((state) => {
      currentMissionId = state.missionId?.trim() ?? '';
      const packet = state.packets.find((candidate) => candidate.id === input.packetId);
      if (!packet) return false;
      if (captureOwnsCurrentSession(input)) sealFirstTaskContract(packet, input.contract);
      return true;
    });
    // The active control-plane copy is authoritative when it owns the packet.
    // Do not fall through to an older registry copy after a rejected capture.
    if (currentPacketFound) return;

    const entry = findMissionRegistryEntryByPacketId(input.packetId, {
      excludeMissionId: currentMissionId || undefined,
    });
    if (!entry) return;
    try {
      await withMissionRegistryState(entry.id, (state) => {
        // The registry updater can intentionally read archived rows for repair.
        // Abort before its writer can revive a mission archived after lookup.
        if (!readMissionRegistryEntry(entry.id)) throw new ArchivedTaskContractMissionError();
        if (captureOwnsCurrentSession(input)) {
          sealFirstTaskContract(
            state.packets.find((candidate) => candidate.id === input.packetId),
            input.contract,
          );
        }
        return { state, result: undefined };
      });
    } catch (error) {
      if (!(error instanceof ArchivedTaskContractMissionError)) throw error;
    }
  });
}

export async function persistTaskContractCapture(input: {
  packetId: string;
  sessionKey: string;
  contract: PacketTaskContract | undefined;
  lane: Lane | null;
  runtime: RuntimeId | null;
  transcript: RuntimeTranscriptEntry[];
  capture: PacketTaskContractCapture | null;
  telemetry?: RuntimeTelemetry;
}): Promise<void> {
  const contract = input.contract;
  if (contract) {
    try {
      await persistToOwningMission({ ...input, contract });
    } catch (error) {
      console.warn(
        `[task-contract] failed to persist captured contract for packet ${input.packetId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  recordTaskContractCostEvent({
    lane: input.lane,
    runtime: input.runtime,
    transcript: input.transcript,
    capture: input.capture,
    telemetry: input.telemetry,
  });
}
