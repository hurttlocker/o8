import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { packetTerminalState } from '@/lib/orchestrator/packet-state';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  listInboxItems,
  resolveInboxItem,
  type SupervisorInboxItem,
  type SupervisorInboxKind,
} from '@/lib/supervisor/inbox';

const ACTIVE_INCIDENT_STATUSES = new Set<SupervisorInboxItem['status']>([
  'pending',
  'healing',
  'human_required',
  'escalated',
]);

const MERGED_PACKET_RESOLVABLE_KINDS = new Set<SupervisorInboxKind>([
  'verification_failed',
  'silent_exit_verification_failed',
  'silent_exit_no_work',
  'silent_exit_but_work_present',
]);

function resolutionNote(input: {
  packetId: string;
  laneId: string | null;
  event: string;
  terminalState: 'released' | 'archived';
}) {
  const status = input.terminalState === 'released' ? 'lane merged' : 'packet archived';
  return [
    `Auto-resolved: ${status}; verification incident no longer applicable.`,
    `packetId=${input.packetId}`,
    `laneId=${input.laneId ?? 'unknown'}`,
    `event=${input.event}`,
  ].join(' ');
}

function resolvingLaneId(packet: OrchestratorPacket, fallbackLaneId?: string | null) {
  return fallbackLaneId?.trim() || packet.lane?.laneId?.trim() || null;
}

export function resolveVerificationIncidentsForMergedPacket(input: {
  packetId: string;
  laneId?: string | null;
  event: string;
  now?: Date;
}): number {
  const packet = readOrchestratorControlPlaneState().packets
    .find((candidate) => candidate.id === input.packetId);
  if (!packet) return 0;

  const terminalState = packetTerminalState(packet);
  if (terminalState !== 'released' && terminalState !== 'archived') return 0;

  const laneId = resolvingLaneId(packet, input.laneId);
  const resolvedAt = (input.now ?? new Date()).toISOString();
  const note = resolutionNote({
    packetId: input.packetId,
    laneId,
    event: input.event,
    terminalState,
  });

  let resolved = 0;
  for (const item of listInboxItems({ includeAllProjects: true })) {
    if (item.packetId !== input.packetId) continue;
    if (!ACTIVE_INCIDENT_STATUSES.has(item.status)) continue;
    if (!MERGED_PACKET_RESOLVABLE_KINDS.has(item.kind)) continue;
    resolveInboxItem(item.id, laneId, {
      note,
      packetId: input.packetId,
      laneId,
      event: input.event,
      terminalState,
      resolvedAt,
    });
    resolved += 1;
  }

  return resolved;
}

export function sweepMergedPacketVerificationIncidents(input: {
  event: string;
  now?: Date;
}): number {
  let resolved = 0;
  for (const packet of readOrchestratorControlPlaneState().packets) {
    const terminalState = packetTerminalState(packet);
    if (terminalState !== 'released' && terminalState !== 'archived') continue;
    resolved += resolveVerificationIncidentsForMergedPacket({
      packetId: packet.id,
      laneId: packet.lane?.laneId ?? null,
      event: input.event,
      now: input.now,
    });
  }
  return resolved;
}

export function autoResolveMergedPacketVerificationIncidents(input: {
  packetId: string;
  laneId?: string | null;
  event: string;
}): void {
  try {
    const resolved = resolveVerificationIncidentsForMergedPacket(input);
    if (resolved > 0) {
      console.log(
        `[supervisor-inbox] Auto-resolved ${resolved} stale verification incident(s) for ${input.event} packet ${input.packetId}`,
      );
    }
  } catch (error) {
    console.warn(
      `[supervisor-inbox] Failed to auto-resolve ${input.event} packet incidents for ${input.packetId}:`,
      error,
    );
  }
}
