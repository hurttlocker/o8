import { withLockedState } from '@/lib/orchestrator/control-plane';
import { recordTaskContractCostEvent, type PacketTaskContractCapture } from '@/lib/orchestrator/task-contract-cost';
import type { PacketTaskContract } from '@/lib/orchestrator/types';
import type { Lane } from '@/lib/lane/types';
import type { RuntimeId, RuntimeTelemetry, RuntimeTranscriptEntry } from '@/lib/runtimes/types';

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
  if (input.contract) {
    try {
      await withLockedState((state) => {
        const packet = state.packets.find((candidate) => candidate.id === input.packetId);
        // Completion may race a retry. Only the session currently bound to this
        // packet can seal its first captured contract; later captures cannot
        // replace it or restore one from an earlier attempt.
        if (packet?.taskContractRequired && !packet.taskContract
          && packet.lane?.sessionKey === input.sessionKey) {
          packet.taskContract = input.contract;
        }
      });
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
