import type { OrchestratorPacket } from '@/lib/orchestrator/types';

// Alignment state lives only on the packet. Normalizing both the original
// huddle intent and its one-time resolution receipt keeps reruns honest.
export function normalizePacketAlignmentResolvedAt(
  value: unknown,
): OrchestratorPacket['alignmentResolvedAt'] {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}
