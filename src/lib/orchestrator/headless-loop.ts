import {
  readOrchestratorControlPlaneState,
  reconcileOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import { buildDagMetadata } from '@/lib/orchestrator/dag';
import { runDispatchTick } from '@/lib/orchestrator/dispatch';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 1_000;

interface HeadlessSprintTickResult {
  launched: number;
  active: number;
  currentWave: number;
  totalWaves: number;
  mission: OrchestratorMissionState;
}

let loopTimer: ReturnType<typeof setInterval> | null = null;
let tickPromise: Promise<HeadlessSprintTickResult> | null = null;
let rerunRequested = false;
const queuedReleasePacketIds = new Set<string>();

function hasLaneBinding(packet: OrchestratorPacket) {
  return Boolean(
    packet.lane?.laneId
    || packet.lane?.sessionKey
    || (packet.lane?.tileId && packet.lane?.tabId),
  );
}

function queueReleasedPackets(packetIds?: string[]) {
  for (const packetId of packetIds ?? []) {
    const normalized = packetId.trim();
    if (normalized) {
      queuedReleasePacketIds.add(normalized);
    }
  }
}

function drainReleasedPackets() {
  const packetIds = [...queuedReleasePacketIds];
  queuedReleasePacketIds.clear();
  return packetIds;
}

function markReleasedPackets(
  state: OrchestratorMissionState,
  packetIds: string[],
): OrchestratorMissionState {
  if (packetIds.length === 0) {
    return state;
  }

  const packetIdSet = new Set(packetIds);
  const releasedAt = new Date().toISOString();
  let changed = false;

  const packets = state.packets.map((packet) => {
    if (!packetIdSet.has(packet.id) || packet.releaseState === 'released') {
      return packet;
    }

    changed = true;
    return {
      ...packet,
      releaseState: 'released',
      status: 'released',
      blockedReason: null,
      lastEventAt: releasedAt,
      lastEventLabel: 'headless_released',
    };
  });

  if (!changed) {
    return state;
  }

  return normalizeOrchestratorMissionState({
    ...state,
    packets,
    updatedAt: releasedAt,
  });
}

function countLaunchedPackets(
  beforeDispatch: OrchestratorMissionState,
  afterDispatch: OrchestratorMissionState,
) {
  const beforeById = new Map(beforeDispatch.packets.map((packet) => [packet.id, packet] as const));

  return afterDispatch.packets.reduce((count, packet) => {
    const previous = beforeById.get(packet.id);
    if (!previous) {
      return count;
    }

    const wasBound = hasLaneBinding(previous);
    const isBound = hasLaneBinding(packet);
    const wasQueued = previous.status === 'queued' && previous.queueState === 'queued';
    const isLaunching = packet.status === 'launching';

    return wasQueued && !wasBound && isBound && isLaunching ? count + 1 : count;
  }, 0);
}

function countActivePackets(state: OrchestratorMissionState) {
  return state.packets.filter((packet) => packet.status === 'launching' || packet.status === 'running').length;
}

async function executeHeadlessSprintTick(): Promise<HeadlessSprintTickResult> {
  let current = readOrchestratorControlPlaneState();
  current = markReleasedPackets(current, drainReleasedPackets());

  const reconciled = reconcileOrchestratorControlPlaneState(current);
  const dispatched = await runDispatchTick(reconciled);
  const mission = writeOrchestratorControlPlaneState(dispatched);
  const dag = buildDagMetadata(mission.packets);
  const launched = countLaunchedPackets(reconciled, mission);
  const active = countActivePackets(mission);

  console.log(`[headless] Tick: ${launched} launched, ${active} active, wave ${dag.currentWave}/${dag.totalWaves}`);

  return {
    launched,
    active,
    currentWave: dag.currentWave,
    totalWaves: dag.totalWaves,
    mission,
  };
}

export async function runHeadlessSprintTick(options: { releasePacketIds?: string[] } = {}) {
  queueReleasedPackets(options.releasePacketIds);

  if (tickPromise) {
    rerunRequested = true;
    return tickPromise;
  }

  tickPromise = (async () => {
    let result: HeadlessSprintTickResult;

    do {
      rerunRequested = false;
      result = await executeHeadlessSprintTick();
    } while (rerunRequested || queuedReleasePacketIds.size > 0);

    return result;
  })()
    .catch((error) => {
      console.error(`[headless] Tick failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    })
    .finally(() => {
      tickPromise = null;
    });

  return tickPromise;
}

export function startHeadlessSprintLoop(intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
  const nextInterval = Number.isFinite(intervalMs)
    ? Math.max(MIN_INTERVAL_MS, Math.floor(intervalMs))
    : DEFAULT_INTERVAL_MS;

  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }

  const timer = setInterval(() => {
    void runHeadlessSprintTick().catch(() => {
      // Logging is handled in runHeadlessSprintTick.
    });
  }, nextInterval);

  loopTimer = timer;
  console.log(`[headless] Started sprint loop (${nextInterval}ms interval)`);

  void runHeadlessSprintTick().catch(() => {
    // Logging is handled in runHeadlessSprintTick.
  });

  return () => {
    clearInterval(timer);
    if (loopTimer === timer) {
      loopTimer = null;
    }
    console.log('[headless] Stopped sprint loop');
  };
}
