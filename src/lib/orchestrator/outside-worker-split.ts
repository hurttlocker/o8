import type { OrchestratorRuntime, WorkerLaunchContext } from './types';

export interface OutsideWorkerSplitRequest {
  sessionKey: string;
  runtime: OrchestratorRuntime;
  repoPath: string;
  packetId?: string | null;
  laneId?: string | null;
  title?: string | null;
  branch?: string | null;
  launchContext?: WorkerLaunchContext | null;
}

interface QueuedOutsideWorkerSplit {
  request: OutsideWorkerSplitRequest;
  claimedBy: string | null;
}

const queued = new Map<string, QueuedOutsideWorkerSplit>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function queueOutsideWorkerSplit(request: OutsideWorkerSplitRequest): void {
  const current = queued.get(request.sessionKey);
  queued.set(request.sessionKey, {
    request,
    claimedBy: current?.claimedBy ?? null,
  });
  notify();
}

export function claimOutsideWorkerSplits(tabId: string): OutsideWorkerSplitRequest[] {
  const claimed: OutsideWorkerSplitRequest[] = [];
  let changed = false;
  for (const entry of queued.values()) {
    if (entry.claimedBy) continue;
    entry.claimedBy = tabId;
    changed = true;
    claimed.push(entry.request);
  }
  if (changed) notify();
  return claimed;
}

export function outsideWorkerSessionKeysForLane(laneId: string): string[] {
  return [...queued.values()]
    .filter((entry) => entry.request.laneId === laneId)
    .map((entry) => entry.request.sessionKey);
}

export function outsideWorkerSessionKeysForPacketIds(packetIds: ReadonlySet<string>): string[] {
  return [...queued.values()]
    .filter((entry) => entry.request.packetId && packetIds.has(entry.request.packetId))
    .map((entry) => entry.request.sessionKey);
}

export function outsideWorkerSessionKeysForSettledPackets(
  packets: ReadonlyArray<{ id: string; status: string; releaseState: string; archivedAt?: string | null }>,
): string[] {
  return outsideWorkerSessionKeysForPacketIds(new Set(packets
    .filter((packet) => packet.releaseState === 'released' || packet.status === 'released' || packet.status === 'archived' || Boolean(packet.archivedAt))
    .map((packet) => packet.id)));
}

export function subscribeOutsideWorkerSplits(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetOutsideWorkerSplitsForTest(): void {
  queued.clear();
  listeners.clear();
}
