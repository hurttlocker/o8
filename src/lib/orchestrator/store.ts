import type {
  OrchestratorLaneBinding,
  OrchestratorLaneSnapshot,
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorQueueState,
  OrchestratorRuntimeTruth,
} from './types';

export const ORCHESTRATOR_STATE_EVENT = 'cortex:orchestrator-state-changed';
export const ORCHESTRATOR_STATE_API_PATH = '/api/orchestrator/state';
const LEGACY_THOUGHTS_STORAGE_KEY = 'cortex-ide:thoughts:mission-control-v1';
const STALE_LANE_REASON = 'Previously bound workspace lane is missing. Re-launch to reattach.';
let orchestratorMissionCache = createEmptyOrchestratorMissionState();

function nowIso() {
  return new Date().toISOString();
}

function packetReferenceIndex(label?: string | null) {
  const match = label?.trim().match(/^P(\d+)$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function nextPacketReferenceLabel(packets: Array<Pick<OrchestratorPacket, 'referenceLabel'>>) {
  const max = packets.reduce((current, packet) => {
    const index = packetReferenceIndex(packet.referenceLabel);
    return index && index > current ? index : current;
  }, 0);
  return `P${max + 1}`;
}

function normalizeQueueState(value: unknown, fallback: OrchestratorQueueState = 'draft'): OrchestratorQueueState {
  return value === 'held'
    ? 'held'
    : value === 'queued'
      ? 'queued'
      : fallback;
}

function normalizeLaneBinding(value: unknown): OrchestratorLaneBinding | null {
  if (!value || typeof value !== 'object') return null;
  const lane = value as Partial<OrchestratorLaneBinding>;
  if (typeof lane.tileId !== 'string' || typeof lane.tabId !== 'string') return null;
  return {
    tileId: lane.tileId,
    tabId: lane.tabId,
    repoPath: typeof lane.repoPath === 'string' ? lane.repoPath : null,
    runtime: lane.runtime === 'claude-code' ? 'claude-code' : 'codex',
    sessionKey: typeof lane.sessionKey === 'string' ? lane.sessionKey : null,
    laneId: typeof lane.laneId === 'string' ? lane.laneId : null,
    lastHeartbeatAt: typeof lane.lastHeartbeatAt === 'string' ? lane.lastHeartbeatAt : null,
    lastEventAt: typeof lane.lastEventAt === 'string' ? lane.lastEventAt : null,
    lastEventLabel: typeof lane.lastEventLabel === 'string' ? lane.lastEventLabel : null,
  };
}

function normalizePacket(raw: unknown, index: number, existing: Array<Pick<OrchestratorPacket, 'referenceLabel'>>) {
  const packet = (raw && typeof raw === 'object' ? raw : {}) as Partial<OrchestratorPacket>;
  const referenceLabel = typeof packet.referenceLabel === 'string' && packet.referenceLabel.trim()
    ? packet.referenceLabel.trim()
    : nextPacketReferenceLabel(existing);
  const queueState = normalizeQueueState(packet.queueState, packet.status === 'queued' ? 'queued' : packet.status === 'running' || packet.status === 'awaiting_review' ? 'queued' : packet.status === 'blocked' ? 'held' : 'draft');
  return {
    id: typeof packet.id === 'string' && packet.id.trim() ? packet.id.trim() : `pkt-${Date.now()}-${index + 1}`,
    referenceLabel,
    title: typeof packet.title === 'string' && packet.title.trim() ? packet.title : `Packet ${index + 1}`,
    summary: typeof packet.summary === 'string' ? packet.summary : '',
    workspaceTargetPath: typeof packet.workspaceTargetPath === 'string' && packet.workspaceTargetPath.trim() ? packet.workspaceTargetPath : null,
    branchTarget: typeof packet.branchTarget === 'string' && packet.branchTarget.trim() ? packet.branchTarget : 'main',
    runtime: packet.runtime === 'claude-code' ? 'claude-code' : 'codex',
    dependencyLabels: Array.isArray(packet.dependencyLabels)
      ? packet.dependencyLabels.map((label) => String(label).trim()).filter(Boolean).slice(0, 8)
      : [],
    dependencyPacketIds: Array.isArray(packet.dependencyPacketIds)
      ? packet.dependencyPacketIds.map((id) => String(id).trim()).filter(Boolean)
      : [],
    queueState,
    releaseState: packet.releaseState === 'released' ? 'released' : 'pending',
    status: packet.status === 'running'
      || packet.status === 'launching'
      || packet.status === 'awaiting_review'
      || packet.status === 'blocked'
      || packet.status === 'queued'
      || packet.status === 'idle'
      || packet.status === 'recovering'
      || packet.status === 'released'
      || packet.status === 'archived'
      ? packet.status
      : queueState === 'queued'
        ? 'queued'
        : 'draft',
    blockedReason: typeof packet.blockedReason === 'string' ? packet.blockedReason : null,
    lastEventAt: typeof packet.lastEventAt === 'string' ? packet.lastEventAt : null,
    lastEventLabel: typeof packet.lastEventLabel === 'string' ? packet.lastEventLabel : null,
    archivedAt: typeof packet.archivedAt === 'string' ? packet.archivedAt : null,
    lane: normalizeLaneBinding(packet.lane),
  } satisfies OrchestratorPacket;
}

function normalizeLookupValue(value: string) {
  return value.trim().toLowerCase();
}

function resolvePacketDependencies(packets: OrchestratorPacket[]) {
  const lookup = new Map<string, string>();
  packets.forEach((packet) => {
    lookup.set(normalizeLookupValue(packet.referenceLabel), packet.id);
    lookup.set(normalizeLookupValue(packet.id), packet.id);
    lookup.set(normalizeLookupValue(packet.title), packet.id);
  });

  return packets.map((packet) => ({
    ...packet,
    dependencyPacketIds: packet.dependencyLabels
      .map((label) => lookup.get(normalizeLookupValue(label)) ?? null)
      .filter((value, index, current): value is string => Boolean(value) && current.indexOf(value) === index),
  }));
}

export function createEmptyOrchestratorMissionState(): OrchestratorMissionState {
  return {
    version: 2,
    prompt: '',
    summary: '',
    packets: [],
    updatedAt: nowIso(),
  };
}

export function normalizeOrchestratorMissionState(raw: unknown): OrchestratorMissionState {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<OrchestratorMissionState>;
  const normalizedPackets = (Array.isArray(value.packets) ? value.packets : []).reduce<OrchestratorPacket[]>((current, packet, index) => {
    current.push(normalizePacket(packet, index, current));
    return current;
  }, []);
  return {
    version: 2,
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    summary: typeof value.summary === 'string' ? value.summary : '',
    packets: resolvePacketDependencies(normalizedPackets),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso(),
  };
}

export function readOrchestratorMissionState(): OrchestratorMissionState {
  return orchestratorMissionCache;
}

function broadcastOrchestratorMissionState(state: OrchestratorMissionState) {
  orchestratorMissionCache = normalizeOrchestratorMissionState(state);
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ORCHESTRATOR_STATE_EVENT, {
    detail: { state: orchestratorMissionCache },
  }));
}

export async function loadOrchestratorMissionState(): Promise<OrchestratorMissionState> {
  if (typeof window === 'undefined') return orchestratorMissionCache;
  try {
    const response = await fetch(ORCHESTRATOR_STATE_API_PATH, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (response.ok) {
      const payload = await response.json() as { mission?: OrchestratorMissionState };
      const next = normalizeOrchestratorMissionState(payload.mission ?? createEmptyOrchestratorMissionState());
      broadcastOrchestratorMissionState(next);
      return next;
    }
  } catch {
    // fall through to legacy migration / cache
  }

  try {
    const legacy = window.localStorage.getItem(LEGACY_THOUGHTS_STORAGE_KEY);
    if (legacy) {
      const migrated = normalizeOrchestratorMissionState(JSON.parse(legacy));
      await persistOrchestratorMissionState(migrated);
      return migrated;
    }
  } catch {
    // ignore malformed legacy state
  }

  return orchestratorMissionCache;
}

export async function persistOrchestratorMissionState(state: OrchestratorMissionState) {
  if (typeof window === 'undefined') return;
  const normalized = normalizeOrchestratorMissionState({
    ...state,
    updatedAt: nowIso(),
  });
  broadcastOrchestratorMissionState(normalized);
  try {
    const response = await fetch(ORCHESTRATOR_STATE_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mission: normalized }),
    });
    if (response.ok) {
      const payload = await response.json() as { mission?: OrchestratorMissionState };
      const next = normalizeOrchestratorMissionState(payload.mission ?? normalized);
      broadcastOrchestratorMissionState(next);
      return next;
    }
  } catch {
    // keep local cache if server write fails
  }
  return normalized;
}

export function updateOrchestratorMissionState(
  updater: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState),
) {
  const next = normalizeOrchestratorMissionState(
    typeof updater === 'function' ? updater(orchestratorMissionCache) : updater,
  );
  broadcastOrchestratorMissionState(next);
  return next;
}

export function subscribeOrchestratorMissionState(listener: (state: OrchestratorMissionState) => void) {
  if (typeof window === 'undefined') return () => {};

  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<{ state?: OrchestratorMissionState }>).detail;
    listener(normalizeOrchestratorMissionState(detail?.state ?? orchestratorMissionCache));
  };

  window.addEventListener(ORCHESTRATOR_STATE_EVENT, handleCustom as EventListener);

  return () => {
    window.removeEventListener(ORCHESTRATOR_STATE_EVENT, handleCustom as EventListener);
  };
}

export function packetReleaseBlockedBy(packet: OrchestratorPacket, packets: OrchestratorPacket[]) {
  const packetById = new Map(packets.map((entry) => [entry.id, entry]));
  return packet.dependencyPacketIds
    .map((dependencyId) => packetById.get(dependencyId) ?? null)
    .find((dependency): dependency is OrchestratorPacket => dependency !== null && dependency.releaseState !== 'released')
    ?? null;
}

export function orchestratorStateDependsOn(packetId: string, packets: OrchestratorPacket[]) {
  return packets.some((packet) => packet.dependencyPacketIds.includes(packetId));
}

function normalizeRuntimeTruthStatus(status?: string | null) {
  const normalized = status?.trim().toLowerCase() ?? '';
  if (normalized === 'reviewing') return 'awaiting_review';
  if (normalized === 'running' || normalized === 'working' || normalized === 'waiting') return 'running';
  if (normalized === 'failed' || normalized === 'blocked' || normalized === 'error') return 'blocked';
  if (normalized === 'idle') return 'idle';
  return null;
}

export interface DomainLaneSummary {
  laneId: string;
  packetId: string;
  status: string;
  sessionKey: string | null;
}

export function reconcileOrchestratorMissionState(
  state: OrchestratorMissionState,
  inputs: {
    laneSnapshots: OrchestratorLaneSnapshot[];
    runtimeTruth: OrchestratorRuntimeTruth[];
    domainLanes?: DomainLaneSummary[];
  },
) {
  const normalized = normalizeOrchestratorMissionState(state);
  const packets = resolvePacketDependencies(normalized.packets);
  const laneByTab = new Map(inputs.laneSnapshots.map((snapshot) => [`${snapshot.tileId}:${snapshot.tabId}`, snapshot] as const));
  const laneBySession = new Map(inputs.laneSnapshots.flatMap((snapshot) => snapshot.sessionKey ? [[snapshot.sessionKey, snapshot] as const] : []));
  const laneByPacketId = new Map(inputs.laneSnapshots.flatMap((snapshot) => snapshot.packetId ? [[snapshot.packetId, snapshot] as const] : []));
  const runtimeTruthBySession = new Map(inputs.runtimeTruth.map((truth) => [truth.sessionKey, truth] as const));

  // ── Lane domain model (passed from server-side caller) ──
  const domainLaneByPacketId: Map<string, { status: string; sessionKey: string | null; laneId: string }> | null =
    inputs.domainLanes && inputs.domainLanes.length > 0
      ? new Map(inputs.domainLanes.map((dl) => [dl.packetId, { status: dl.status, sessionKey: dl.sessionKey, laneId: dl.laneId }]))
      : null;

  const reconciledPackets = packets.map((packet) => {
    const dependency = packetReleaseBlockedBy(packet, packets);
    const laneMatch = packet.lane
      ? laneByTab.get(`${packet.lane.tileId}:${packet.lane.tabId}`)
        ?? (packet.lane.sessionKey ? laneBySession.get(packet.lane.sessionKey) : undefined)
        ?? laneByPacketId.get(packet.id)
      : laneByPacketId.get(packet.id);
    const runtime = laneMatch?.sessionKey ? runtimeTruthBySession.get(laneMatch.sessionKey) : undefined;
    const domainLane = domainLaneByPacketId?.get(packet.id) ?? null;
    const laneId = domainLane?.laneId ?? packet.lane?.laneId ?? null;
    const next: OrchestratorPacket = {
      ...packet,
      lane: laneMatch
        ? {
            tileId: laneMatch.tileId,
            tabId: laneMatch.tabId,
            repoPath: laneMatch.repoPath,
            runtime: laneMatch.runtime,
            sessionKey: laneMatch.sessionKey ?? domainLane?.sessionKey ?? null,
            laneId,
            lastHeartbeatAt: laneMatch.lastActivityAt,
            lastEventAt: runtime?.lastEventAt ?? packet.lane?.lastEventAt ?? laneMatch.lastActivityAt ?? null,
            lastEventLabel: runtime?.currentTask ?? runtime?.workflowStageLabel ?? packet.lane?.lastEventLabel ?? null,
          }
        : packet.lane?.laneId
          ? { ...packet.lane, laneId, sessionKey: domainLane?.sessionKey ?? packet.lane?.sessionKey ?? null }
          : null,
      lastEventAt: runtime?.lastEventAt ?? packet.lastEventAt ?? packet.lane?.lastHeartbeatAt ?? null,
      lastEventLabel: runtime?.currentTask ?? runtime?.workflowStageLabel ?? packet.lastEventLabel ?? packet.lane?.lastEventLabel ?? null,
      blockedReason: null,
    };

    if (packet.archivedAt) {
      next.status = 'archived';
      next.blockedReason = null;
      return next;
    }

    if (packet.releaseState === 'released') {
      next.status = 'released';
      next.blockedReason = null;
      return {
        ...next,
        lane: laneMatch ? next.lane : null,
      };
    }

    if (packet.queueState === 'held') {
      next.status = 'blocked';
      next.blockedReason = 'Held by operator';
      return next;
    }

    if (dependency) {
      next.status = 'blocked';
      next.blockedReason = `Waiting on ${dependency.referenceLabel} to be explicitly released`;
      return next;
    }

    // ── Lane domain model status takes priority when available ──
    if (domainLane) {
      const ds = domainLane.status;
      if (ds === 'reviewing') { next.status = 'awaiting_review'; return next; }
      if (ds === 'merging') { next.status = 'awaiting_review'; next.blockedReason = 'Merge in progress'; return next; }
      if (ds === 'completed') { next.status = 'released'; next.releaseState = 'released'; return next; }
      if (ds === 'archived') { next.status = 'archived'; return next; }
      if (ds === 'running') { next.status = 'running'; return next; }
      if (ds === 'launching') { next.status = 'launching'; return next; }
      if (ds === 'awaiting_input') { next.status = 'blocked'; next.blockedReason = 'Awaiting operator input'; return next; }
      if (ds === 'paused' && domainLane.sessionKey) { next.status = 'idle'; return next; }
      if (ds === 'paused' && !domainLane.sessionKey) { next.status = 'recovering'; next.blockedReason = 'Session lost — re-launch to reattach.'; return next; }
    }

    if (laneMatch) {
      const truthStatus = normalizeRuntimeTruthStatus(runtime?.status);
      if (truthStatus === 'awaiting_review') {
        next.status = 'awaiting_review';
        return next;
      }
      if (truthStatus === 'blocked') {
        next.status = 'blocked';
        next.blockedReason = runtime?.currentTask ?? `Runtime reported ${runtime?.status ?? 'blocked'}`;
        return next;
      }
      // Only trust 'running' if the agent is actually in the fleet snapshot
      if (runtime && (truthStatus === 'running' || laneMatch.status === 'running')) {
        next.status = 'running';
        return next;
      }
      // Agent not in fleet but lane claims running → stale cache, mark idle
      if (!runtime && laneMatch.status === 'running') {
        next.status = 'idle';
        return next;
      }
      if (laneMatch.sessionKey) {
        next.status = 'idle';
      } else {
        // Launch timeout: if launching > 90s without a session, mark recovering
        const lastActivity = packet.lane?.lastHeartbeatAt ?? packet.lastEventAt ?? null;
        const launchAge = lastActivity ? Date.now() - new Date(lastActivity).getTime() : 0;
        if (launchAge > 90_000) {
          next.status = 'recovering';
          next.blockedReason = 'Launch timed out — session never attached. Re-launch to retry.';
        } else {
          next.status = 'launching';
        }
      }
      return next;
    }

    if (packet.lane && !laneMatch && !domainLane) {
      next.status = 'recovering';
      next.blockedReason = STALE_LANE_REASON;
      return {
        ...next,
        lane: null,
      };
    }

    if (!packet.lane && packet.blockedReason === STALE_LANE_REASON) {
      next.status = 'recovering';
      next.blockedReason = STALE_LANE_REASON;
      return next;
    }

    next.status = packet.queueState === 'queued' ? 'queued' : 'draft';
    return next;
  });

  const nextState = normalizeOrchestratorMissionState({
    ...normalized,
    packets: reconciledPackets,
  });
  const changed = JSON.stringify({
    prompt: normalized.prompt,
    summary: normalized.summary,
    packets: normalized.packets,
  }) !== JSON.stringify({
    prompt: nextState.prompt,
    summary: nextState.summary,
    packets: nextState.packets,
  });

  return changed
    ? { ...nextState, updatedAt: nowIso() }
    : normalized;
}
