import { randomUUID } from 'node:crypto';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { withMissionHandoffBarrier } from '@/lib/orchestrator/lifecycle-mutation-lock';
import {
  findMissionRegistryEntryByPacketId,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

export interface PacketLifecycleGuard {
  packetId: string;
  missionId: string;
  source: string;
  repoPath: string;
  previousPacket: OrchestratorPacket;
  heldPacket: OrchestratorPacket;
}

export interface PacketLifecycleMutationResult<T> {
  matched: boolean;
  result?: T;
}

function markPacketLifecycleHeld(
  packet: OrchestratorPacket,
  source: string,
  blockedReason: string,
): void {
  packet.status = 'blocked';
  packet.queueState = 'held';
  packet.operatorStopped = true;
  packet.releaseState = 'pending';
  packet.releaseStatePayload = { source };
  packet.blockedReason = blockedReason;
  packet.lastEventAt = new Date().toISOString();
  packet.lastEventLabel = blockedReason;
}

export function packetLifecycleGuardMatches(
  packet: OrchestratorPacket,
  guard: PacketLifecycleGuard,
): boolean {
  return packet.id === guard.packetId
    && packet.queueState === 'held'
    && packet.operatorStopped === true
    && packet.releaseStatePayload?.source === guard.source;
}

/**
 * Thrown when an automatic caller asked to preserve a durable operator Stop and
 * the packet already carries one. Refusing before marking the lifecycle hold
 * keeps the stop, its retry budget, and any bound lanes intact.
 */
export class PacketOperatorStopPreservedError extends Error {
  constructor(packetId: string) {
    super(`Packet ${packetId} has a durable operator stop; the requested lifecycle mutation was refused so the stop is preserved.`);
    this.name = 'PacketOperatorStopPreservedError';
  }
}

const OPERATOR_STOP_REFUSAL = 'operator_stop_refusal' as const;

export function holdPacketLifecycleMutation(input: {
  packetId: string;
  kind: 'close' | 'rerun' | 'stop';
  /**
   * Automatic recovery sets this so a durable operator Stop that already owns
   * the packet is preserved. Explicit/manual callers omit it: an operator rerun
   * may intentionally clear a prior stop.
   */
  preserveOperatorStop?: boolean;
}): Promise<PacketLifecycleGuard | null> {
  return withMissionHandoffBarrier(async (): Promise<PacketLifecycleGuard | null> => {
    const source = `${input.kind === 'stop' ? 'operator_stop' : input.kind}:${randomUUID()}`;
    const blockedReason = `${input.kind}_in_progress`;
    let currentMissionId = '';
    const { result: activeResult } = await withLockedState<
      PacketLifecycleGuard | typeof OPERATOR_STOP_REFUSAL | null
    >((state) => {
      currentMissionId = state.missionId?.trim() ?? '';
      const packet = state.packets.find((candidate) => candidate.id === input.packetId);
      if (!packet) return null;
      // Refuse inside the owning state's lock BEFORE marking the hold, and never
      // let the refusal fall through to an older registry copy.
      if (input.preserveOperatorStop === true && packet.operatorStopped === true) {
        return OPERATOR_STOP_REFUSAL;
      }
      if (!currentMissionId) return null;
      const previousPacket = structuredClone(packet);
      markPacketLifecycleHeld(packet, source, blockedReason);
      return {
        packetId: input.packetId,
        missionId: currentMissionId,
        source,
        repoPath: state.repoPath?.trim() || packet.lane?.repoPath?.trim() || '',
        previousPacket,
        heldPacket: structuredClone(packet),
      } satisfies PacketLifecycleGuard;
    });
    if (activeResult === OPERATOR_STOP_REFUSAL) {
      throw new PacketOperatorStopPreservedError(input.packetId);
    }
    if (activeResult) return activeResult;

    const entry = findMissionRegistryEntryByPacketId(input.packetId, {
      includeArchived: true,
      excludeMissionId: currentMissionId || undefined,
    });
    if (!entry) return null;
    const { result } = await withMissionRegistryState<
      PacketLifecycleGuard | typeof OPERATOR_STOP_REFUSAL | null
    >(entry.id, (state) => {
      const packet = state.packets.find((candidate) => candidate.id === input.packetId);
      if (!packet) return { state, result: null };
      if (input.preserveOperatorStop === true && packet.operatorStopped === true) {
        return { state, result: OPERATOR_STOP_REFUSAL };
      }
      const previousPacket = structuredClone(packet);
      markPacketLifecycleHeld(packet, source, blockedReason);
      return {
        state,
        result: {
          packetId: input.packetId,
          missionId: entry.id,
          source,
          repoPath: state.repoPath?.trim() || packet.lane?.repoPath?.trim() || '',
          previousPacket,
          heldPacket: structuredClone(packet),
        } satisfies PacketLifecycleGuard,
      };
    });
    if (result === OPERATOR_STOP_REFUSAL) {
      throw new PacketOperatorStopPreservedError(input.packetId);
    }
    return result;
  });
}

export function mutatePacketLifecycleGuard<T>(
  guard: PacketLifecycleGuard,
  mutate: (
    packet: OrchestratorPacket,
    state: OrchestratorMissionState,
  ) => T | Promise<T>,
): Promise<PacketLifecycleMutationResult<T>> {
  return withMissionHandoffBarrier(async () => {
    const { result: currentResult } = await withLockedState<PacketLifecycleMutationResult<T> | null>(async (state) => {
      if (state.missionId !== guard.missionId) return null;
      const packet = state.packets.find((candidate) => candidate.id === guard.packetId);
      if (!packet || !packetLifecycleGuardMatches(packet, guard)) {
        return { matched: false } satisfies PacketLifecycleMutationResult<T>;
      }
      return {
        matched: true,
        result: await mutate(packet, state),
      } satisfies PacketLifecycleMutationResult<T>;
    });
    if (currentResult) return currentResult;

    const { result } = await withMissionRegistryState<PacketLifecycleMutationResult<T>>(guard.missionId, async (state) => {
      const packet = state.packets.find((candidate) => candidate.id === guard.packetId);
      if (!packet || !packetLifecycleGuardMatches(packet, guard)) {
        return { state, result: { matched: false } satisfies PacketLifecycleMutationResult<T> };
      }
      return {
        state,
        result: {
          matched: true,
          result: await mutate(packet, state),
        } satisfies PacketLifecycleMutationResult<T>,
      };
    });
    return result;
  });
}

export async function restorePacketLifecycleGuard(guard: PacketLifecycleGuard): Promise<boolean> {
  const restored = await mutatePacketLifecycleGuard(guard, (packet) => {
    Object.assign(packet, structuredClone(guard.previousPacket));
    return true;
  });
  return restored.matched && restored.result === true;
}

export async function markPacketLifecycleFailure(
  guard: PacketLifecycleGuard,
  reason:
    | 'kill_unconfirmed'
    | 'session_archive_unconfirmed'
    | 'worktree_cleanup_failed'
    | 'branch_preservation_failed'
    | 'lane_archive_failed'
    | 'rerun_failed'
    | 'close_failed',
): Promise<boolean> {
  const marked = await mutatePacketLifecycleGuard(guard, (packet) => {
    packet.status = 'blocked';
    packet.queueState = 'held';
    packet.operatorStopped = true;
    packet.blockedReason = reason;
    if (reason === 'rerun_failed') packet.lane = null;
    packet.lastEventAt = new Date().toISOString();
    packet.lastEventLabel = reason;
    return true;
  });
  return marked.matched && marked.result === true;
}
