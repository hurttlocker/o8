/**
 * steerPacket — nudge a packet's warm session with a follow-up message.
 *
 * CLI-as-control-plane symmetry (Orca teardown #2, Stage 4). This was the one
 * mission verb with no HTTP route: the MCP `steer_packet` handler resolved the
 * lane and flipped its status IN ITS OWN PROCESS (a separate in-memory registry
 * instance from the app), only the runtime steer itself crossing the HTTP seam.
 * Extracting it here — and routing both the MCP tool and the `o8 packet steer`
 * CLI through `/api/orchestrator/steer-packet` — means the lane resolution +
 * status flip run in the Next process where the live registry and warm-session
 * pool actually live. Removes the cross-process-registry fragility.
 *
 * Layer 3 of the merge-failure escalation chain (CLAUDE.md): cheaper than a
 * fresh redispatch because it reuses the warm Codex thread.
 */

import { findLaneByPacket, setLaneStatus } from '@/lib/lane/registry';
import { rebindLaneSessionIfChanged } from '@/lib/lane/session-rebind';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { performRuntimeAction } from '@/lib/runtime/actions';
import { currentMissionState } from './shared';
import { continueOwnedCodexSession, getOwnedCodexTelemetrySources } from '@/lib/codex/owned';

export interface SteerPacketInput {
  packetId: string;
  message: string;
}

export interface SteerPacketResult {
  packetId: string;
  laneId: string;
  note: string;
}

const NO_STEERABLE_SESSION = 'Packet has no steerable session — use rerun_with_feedback instead.';

async function resumeExitedOwnedCodexSession(surfaceId: string, message: string) {
  if (!surfaceId.startsWith('codex-owned:')) {
    return null;
  }

  const sources = await getOwnedCodexTelemetrySources(surfaceId);
  if (!sources?.threadId) {
    return null;
  }

  return continueOwnedCodexSession(surfaceId, message);
}

export async function steerPacket({ packetId, message }: SteerPacketInput): Promise<SteerPacketResult> {
  const lane = findLaneByPacket(packetId);
  if (!lane?.sessionKey) {
    const current = currentMissionState();
    const packetExists = current.packets.some((packet) => packet.id === packetId)
      || Boolean(findMissionRegistryEntryByPacketId(packetId, {
        includeArchived: true,
        excludeMissionId: current.missionId,
      }));
    if (!packetExists) {
      throw new Error(`Packet ${packetId} not found.`);
    }
    throw new Error(NO_STEERABLE_SESSION);
  }

  const result = await performRuntimeAction({ action: 'steer', surfaceId: lane.sessionKey, message });
  if (!result.ok || result.status === 'unavailable') {
    const resumed = await resumeExitedOwnedCodexSession(lane.sessionKey, message);
    if (!resumed?.ok) {
      if (lane.sessionKey.startsWith('codex-owned:')) {
        throw new Error(resumed?.note || NO_STEERABLE_SESSION);
      }
      throw new Error(resumed?.note || result.note || NO_STEERABLE_SESSION);
    }
  } else {
    rebindLaneSessionIfChanged(lane.id, lane.sessionKey, result.sessionKey, 'orchestrator');
  }

  const updated = setLaneStatus(lane.id, 'running', 'orchestrator', 'steered_packet');
  if (!updated || updated.status !== 'running') {
    throw new Error(NO_STEERABLE_SESSION);
  }

  return { packetId, laneId: lane.id, note: 'Steered packet via warm session.' };
}
