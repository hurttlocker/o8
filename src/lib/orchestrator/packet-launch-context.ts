import 'server-only';

import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { WorkerLaunchContext } from '@/lib/orchestrator/types';

export interface ResolvedPacketLaunchContext {
  launchContext: WorkerLaunchContext;
  missionId: string | null;
}

export function resolvePacketLaunchContexts(
  packetIds: Iterable<string>,
): Map<string, ResolvedPacketLaunchContext> {
  const unresolved = new Set(
    Array.from(packetIds, (packetId) => packetId.trim()).filter(Boolean),
  );
  const resolved = new Map<string, ResolvedPacketLaunchContext>();
  if (unresolved.size === 0) return resolved;

  const current = normalizeOrchestratorMissionState(readOrchestratorControlPlaneState());
  for (const packet of current.packets) {
    if (!unresolved.has(packet.id) || !packet.launchContext) continue;
    resolved.set(packet.id, {
      launchContext: packet.launchContext,
      missionId: current.missionId?.trim() || null,
    });
    unresolved.delete(packet.id);
  }

  if (unresolved.size === 0) return resolved;
  for (const entry of listMissionRegistryEntries({ includeArchived: true })) {
    for (const packet of entry.mission.packets) {
      if (!unresolved.has(packet.id) || !packet.launchContext) continue;
      resolved.set(packet.id, { launchContext: packet.launchContext, missionId: entry.id });
      unresolved.delete(packet.id);
    }
    if (unresolved.size === 0) break;
  }

  return resolved;
}

export function resolvePacketLaunchContext(packetId: string): ResolvedPacketLaunchContext | null {
  return resolvePacketLaunchContexts([packetId]).get(packetId.trim()) ?? null;
}
