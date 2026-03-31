import type {
  DagNode,
  OrchestratorDagMetadata,
  OrchestratorDagWave,
  OrchestratorPacket,
} from '@/lib/orchestrator/types';

export type { DagNode } from '@/lib/orchestrator/types';

function dedupeIds(ids: string[]) {
  return ids.filter((id, index) => id.trim() && ids.indexOf(id) === index);
}

function hasLaneBinding(packet: OrchestratorPacket) {
  return Boolean(
    packet.lane?.laneId
    || packet.lane?.sessionKey
    || (packet.lane?.tileId && packet.lane?.tabId),
  );
}

function buildPacketLookup(packets: OrchestratorPacket[]) {
  return new Map(packets.map((packet) => [packet.id, packet] as const));
}

function computeWave(
  packet: OrchestratorPacket,
  packetLookup: Map<string, OrchestratorPacket>,
  memo: Map<string, number>,
  visiting: Set<string>,
): number {
  const cached = memo.get(packet.id);
  if (cached !== undefined) {
    return cached;
  }

  if (visiting.has(packet.id)) {
    return 1;
  }

  visiting.add(packet.id);
  const dependencyWaves = dedupeIds(packet.dependencyPacketIds)
    .map((dependencyId) => {
      const dependency = packetLookup.get(dependencyId);
      if (!dependency) {
        return 0;
      }
      return computeWave(dependency, packetLookup, memo, visiting);
    });
  visiting.delete(packet.id);

  const wave = dependencyWaves.length > 0 ? Math.max(...dependencyWaves) + 1 : 1;
  memo.set(packet.id, wave);
  return wave;
}

export function buildDependencyGraph(packets: OrchestratorPacket[]): DagNode[] {
  const packetLookup = buildPacketLookup(packets);
  const memo = new Map<string, number>();

  return packets.map((packet) => {
    const dependsOn = dedupeIds(packet.dependencyPacketIds);
    const blockedBy = dependsOn.filter((dependencyId) => {
      const dependency = packetLookup.get(dependencyId);
      return !dependency || dependency.releaseState !== 'released';
    });

    return {
      packetId: packet.id,
      title: packet.title,
      status: packet.status,
      dependsOn,
      blockedBy,
      wave: computeWave(packet, packetLookup, memo, new Set<string>()),
    };
  });
}

export function getDispatchableWave(packets: OrchestratorPacket[]): OrchestratorPacket[] {
  const graph = buildDependencyGraph(packets);
  const blockedByPacketId = new Map(graph.map((node) => [node.packetId, node.blockedBy] as const));

  return packets.filter((packet) => {
    const blockedBy = blockedByPacketId.get(packet.id) ?? [];
    return packet.queueState === 'queued'
      && packet.status === 'queued'
      && packet.releaseState !== 'released'
      && Boolean(packet.workspaceTargetPath)
      && !hasLaneBinding(packet)
      && blockedBy.length === 0;
  });
}

export function getDagDepth(packets: OrchestratorPacket[]): number {
  return buildDependencyGraph(packets).reduce((maxDepth, node) => Math.max(maxDepth, node.wave), 0);
}

export function buildDagMetadata(packets: OrchestratorPacket[]): OrchestratorDagMetadata {
  const nodes = buildDependencyGraph(packets);
  const totalWaves = nodes.reduce((maxDepth, node) => Math.max(maxDepth, node.wave), 0);
  const pendingNodes = nodes.filter((node) => node.status !== 'released' && node.status !== 'archived');
  const currentWave = pendingNodes.length > 0
    ? pendingNodes.reduce((minWave, node) => Math.min(minWave, node.wave), pendingNodes[0].wave)
    : totalWaves;

  const waves: OrchestratorDagWave[] = Array.from({ length: totalWaves }, (_, index) => index + 1)
    .map((wave) => {
      const packetsInWave = nodes.filter((node) => node.wave === wave);
      return {
        wave,
        packetIds: packetsInWave.map((node) => node.packetId),
        packets: packetsInWave,
      };
    })
    .filter((wave) => wave.packets.length > 0);

  return {
    currentWave,
    totalWaves,
    waves,
  };
}
