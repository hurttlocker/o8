import { getRuntime } from '@/lib/runtimes';
import { readPersistedSessionCosts } from '@/lib/orchestrator/cost-persistence';
import type { UsageRole } from '@/lib/db/usage';
import { resolveRuntimeSessionIdentityId } from '@/lib/runtime/session-identity';
import { runtimeIdFromSessionKey } from '@/lib/runtime/transcript';
import {
  ORCHESTRATOR_RUNTIME_IDS,
  isOrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorMissionState, OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { PacketCostSource } from '@/lib/orchestrator/metered-spend';

export interface PacketCostSummary {
  packetId: string;
  sessionKey: string | null;
  runtime: OrchestratorRuntime;
  identityId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  hasTelemetry: boolean;
  costSource: PacketCostSource;
}

export interface RuntimeTokenSummary {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  packetCount: number;
}

export interface RoleCostSummary {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  requestCount: number;
}

export interface MissionCostSummary {
  totalCostUsd: number;
  packetCosts: PacketCostSummary[];
  tokensByRuntime: Record<OrchestratorRuntime, RuntimeTokenSummary>;
  costByRole: Record<UsageRole, RoleCostSummary>;
  /** Usage from a session shared by multiple packets; never guessed onto one packet. */
  unattributed: {
    sessionCount: number;
    /** Sessions reused by another mission whose lifetime telemetry cannot be split truthfully. */
    unknownSessionCount: number;
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
  };
}

/**
 * Minimal lane info needed for cost aggregation. Populated from the live
 * lane registry so cost resolution is not blocked by a stale or null
 * packet.lane binding from the orchestrator state snapshot.
 */
export interface LaneSessionInfo {
  sessionKey: string | null;
  runtime: OrchestratorRuntime;
  createdAt?: string | null;
}

type LaneSessionHistory = Map<string, LaneSessionInfo | LaneSessionInfo[]> & {
  crossMissionSessionKeys?: Set<string>;
};

type CachedTelemetrySummary = {
  identityId: string | null;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  model: string | null;
  hasTelemetry: boolean;
  costSource: PacketCostSource;
  /** undefined means live telemetry may inherit packet context; null means a persisted row is explicitly unattributed. */
  persistedPacketId?: string | null;
  costByRole: Record<UsageRole, RoleCostSummary>;
};

type AttributedSessionCost = CachedTelemetrySummary & {
  packetId: string | null;
  sessionKey: string;
  runtime: OrchestratorRuntime;
};

function toFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function roundUsd(value: number) {
  return Number(value.toFixed(6));
}

function emptyRuntimeTokenSummary(): RuntimeTokenSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
    packetCount: 0,
  };
}

function emptyRoleCostSummary(): RoleCostSummary {
  return { inputTokens: 0, outputTokens: 0, totalCostUsd: 0, requestCount: 0 };
}

function emptyCostByRole(): Record<UsageRole, RoleCostSummary> {
  return {
    orchestrator: emptyRoleCostSummary(),
    worker: emptyRoleCostSummary(),
    reviewer: emptyRoleCostSummary(),
    compaction: emptyRoleCostSummary(),
    retrieval: emptyRoleCostSummary(),
    other: emptyRoleCostSummary(),
  };
}

function buildEmptyPacketCostSummary(
  packet: OrchestratorPacket,
  laneInfo?: LaneSessionInfo | null,
): PacketCostSummary {
  const sessionKey = laneInfo?.sessionKey?.trim() || packet.lane?.sessionKey?.trim() || null;
  const runtime = laneInfo?.runtime ?? packet.lane?.runtime ?? packet.runtime;
  return {
    packetId: packet.id,
    sessionKey,
    runtime,
    identityId: null,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
    hasTelemetry: false,
    costSource: 'unknown',
  };
}

export function laneSessionHistoryForMission(
  state: OrchestratorMissionState,
  lanes: Array<{
    packetId: string | null;
    sessionKey: string | null;
    runtime: OrchestratorRuntime;
    createdAt: string;
    sessionHistory?: Array<{
      sessionKey: string;
      runtime: OrchestratorRuntime;
      createdAt: string;
    }>;
    historicalPacketId?: string | null;
  }>,
): LaneSessionHistory {
  const packetIds = new Set(state.packets.map((packet) => packet.id));
  const history: LaneSessionHistory = new Map<string, LaneSessionInfo[]>();
  const globalSessionPackets = new Map<string, Set<string>>();
  for (const lane of [...lanes].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    const owningPacketId = lane.packetId?.trim() || lane.historicalPacketId?.trim() || null;
    const sessions = [...(lane.sessionHistory ?? [])];
    if (lane.sessionKey?.trim() && !sessions.some((entry) => entry.sessionKey === lane.sessionKey)) {
      sessions.push({ sessionKey: lane.sessionKey, runtime: lane.runtime, createdAt: lane.createdAt });
    }
    if (owningPacketId) {
      for (const session of sessions) {
        const owners = globalSessionPackets.get(session.sessionKey) ?? new Set<string>();
        owners.add(owningPacketId);
        globalSessionPackets.set(session.sessionKey, owners);
      }
    }
    if (!owningPacketId || !packetIds.has(owningPacketId)) continue;
    const existingEntries = history.get(owningPacketId);
    const entries = Array.isArray(existingEntries)
      ? existingEntries
      : existingEntries
        ? [existingEntries]
        : [];
    for (const session of sessions) {
      if (entries.some((entry) => entry.sessionKey === session.sessionKey)) continue;
      entries.push(session);
    }
    history.set(owningPacketId, entries);
  }
  history.crossMissionSessionKeys = new Set(
    [...globalSessionPackets]
      .filter(([, owners]) => [...owners].some((packetId) => !packetIds.has(packetId)))
      .map(([sessionKey]) => sessionKey),
  );
  return history;
}

export function runtimeFromSessionKey(sessionKey: string | null | undefined): OrchestratorRuntime | null {
  const normalized = sessionKey?.trim() ?? '';
  if (!normalized) return null;
  const runtimeId = runtimeIdFromSessionKey(normalized);
  return isOrchestratorRuntime(runtimeId) ? runtimeId : null;
}

async function resolveSessionTelemetry(
  sessionKey: string,
  runtime: OrchestratorRuntime,
  cache: Map<string, CachedTelemetrySummary>,
): Promise<CachedTelemetrySummary> {
  const cached = cache.get(sessionKey);
  if (cached) {
    return cached;
  }

  const adapter = getRuntime(runtime);
  const identityId = await resolveRuntimeSessionIdentityId(runtime, sessionKey);
  let resolved: CachedTelemetrySummary | null = null;

  if (adapter?.capabilities.costTelemetry && adapter.getTelemetry) {
    try {
      const telemetry = await adapter.getTelemetry(sessionKey);
      if (telemetry) {
        resolved = {
          identityId,
          inputTokens: toFiniteNumber(telemetry.inputTokens),
          outputTokens: toFiniteNumber(telemetry.outputTokens),
          totalCostUsd: roundUsd(toFiniteNumber(telemetry.estimatedCostUsd)),
          model: telemetry.model?.trim() || null,
          hasTelemetry: true,
          costSource: telemetry.costSource ?? 'estimate',
          costByRole: {
            ...emptyCostByRole(),
            worker: {
              inputTokens: toFiniteNumber(telemetry.inputTokens),
              outputTokens: toFiniteNumber(telemetry.outputTokens),
              totalCostUsd: roundUsd(toFiniteNumber(telemetry.estimatedCostUsd)),
              requestCount: 1,
            },
          },
        };
      }
    } catch (error) {
      console.error(`[cost-agg] Failed to load telemetry for ${sessionKey}.`, error);
    }
  }

  const persistedRows = readPersistedSessionCosts(sessionKey);
  if (persistedRows.length > 0) {
    const costByRole = emptyCostByRole();
    for (const row of persistedRows) {
      const role = row.role ?? 'other';
      const subtotal = costByRole[role];
      subtotal.inputTokens += row.inputTokens;
      subtotal.outputTokens += row.outputTokens;
      subtotal.totalCostUsd = roundUsd(subtotal.totalCostUsd + row.totalCostUsd);
      subtotal.requestCount += 1;
    }
    const packetIds = new Set(persistedRows.map((row) => row.packetId));
    const persistedPacketId = packetIds.size === 1 ? [...packetIds][0] : null;
    if (resolved) {
      resolved = { ...resolved, persistedPacketId, costByRole };
    } else {
      const models = new Set(persistedRows.map((row) => row.model).filter((model): model is string => Boolean(model)));
      resolved = {
        identityId,
        inputTokens: persistedRows.reduce((sum, row) => sum + row.inputTokens, 0),
        outputTokens: persistedRows.reduce((sum, row) => sum + row.outputTokens, 0),
        totalCostUsd: roundUsd(persistedRows.reduce((sum, row) => sum + row.totalCostUsd, 0)),
        model: models.size === 1 ? [...models][0] : models.size > 1 ? 'mixed' : null,
        hasTelemetry: true,
        costSource: persistedRows.some((row) => row.costSource === 'gateway') ? 'gateway' : 'estimate',
        persistedPacketId,
        costByRole,
      };
    }
  }

  const next = resolved ?? {
        identityId,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        model: null,
        hasTelemetry: false,
        costSource: 'unknown',
        costByRole: emptyCostByRole(),
      };
  cache.set(sessionKey, next);
  return next;
}

function laneInfosForPacket(
  packet: OrchestratorPacket,
  history?: LaneSessionHistory | null,
): LaneSessionInfo[] {
  const fromHistory = history?.get(packet.id);
  const entries = Array.isArray(fromHistory)
    ? fromHistory
    : fromHistory
      ? [fromHistory]
      : [];
  const packetLane = packet.lane?.sessionKey?.trim()
    ? [{ sessionKey: packet.lane.sessionKey, runtime: packet.lane.runtime }]
    : [];
  return [...entries, ...packetLane];
}

async function resolvePacketTelemetry(
  packet: OrchestratorPacket,
  cache: Map<string, CachedTelemetrySummary>,
  claimedSessionKeys: Set<string>,
  ambiguousSessionKeys: Set<string>,
  history?: LaneSessionHistory | null,
): Promise<{ packetCost: PacketCostSummary; sessionCosts: AttributedSessionCost[] }> {
  const candidates = laneInfosForPacket(packet, history);
  const fallback = buildEmptyPacketCostSummary(packet, candidates[0]);
  const models = new Set<string>();
  const identityIds = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCostUsd = 0;
  let hasTelemetry = false;
  const costSources = new Set<PacketCostSource>();
  const sessionCosts: AttributedSessionCost[] = [];

  for (const candidate of candidates) {
    const sessionKey = candidate.sessionKey?.trim();
    if (!sessionKey || claimedSessionKeys.has(sessionKey) || ambiguousSessionKeys.has(sessionKey)) continue;
    claimedSessionKeys.add(sessionKey);
    const runtime = runtimeFromSessionKey(sessionKey) ?? candidate.runtime;
    const telemetry = await resolveSessionTelemetry(sessionKey, runtime, cache);
    const resolvedPacketId = telemetry.persistedPacketId === undefined
      ? packet.id
      : telemetry.persistedPacketId;
    sessionCosts.push({ ...telemetry, packetId: resolvedPacketId, sessionKey, runtime });
    if (resolvedPacketId !== packet.id) continue;
    inputTokens += telemetry.inputTokens;
    outputTokens += telemetry.outputTokens;
    totalCostUsd += telemetry.totalCostUsd;
    hasTelemetry = hasTelemetry || telemetry.hasTelemetry;
    if (telemetry.hasTelemetry) costSources.add(telemetry.costSource);
    if (telemetry.model) models.add(telemetry.model);
    if (telemetry.identityId) identityIds.add(telemetry.identityId);
  }

  return {
    packetCost: {
      ...fallback,
      model: models.size === 1 ? [...models][0] : models.size > 1 ? 'mixed' : null,
      identityId: identityIds.size === 1 ? [...identityIds][0] : null,
      inputTokens,
      outputTokens,
      totalCostUsd: roundUsd(totalCostUsd),
      hasTelemetry,
      costSource: costSources.has('estimate') ? 'estimate' : costSources.has('gateway') ? 'gateway' : 'unknown',
    },
    sessionCosts,
  };
}

export async function aggregateMissionCost(
  state: OrchestratorMissionState,
  laneByPacketId?: LaneSessionHistory | null,
): Promise<MissionCostSummary> {
  const cache = new Map<string, CachedTelemetrySummary>();
  const claimedSessionKeys = new Set<string>();
  const sessionPackets = new Map<string, Set<string>>();
  for (const packet of state.packets) {
    for (const candidate of laneInfosForPacket(packet, laneByPacketId)) {
      const sessionKey = candidate.sessionKey?.trim();
      if (!sessionKey) continue;
      const packets = sessionPackets.get(sessionKey) ?? new Set<string>();
      packets.add(packet.id);
      sessionPackets.set(sessionKey, packets);
    }
  }
  const ambiguousSessionKeys = new Set(
    [...sessionPackets].filter(([, packets]) => packets.size > 1).map(([sessionKey]) => sessionKey),
  );
  const crossMissionSessionKeys = new Set(
    [...laneByPacketId?.crossMissionSessionKeys ?? []]
      .filter((sessionKey) => sessionPackets.has(sessionKey)),
  );
  for (const sessionKey of crossMissionSessionKeys) ambiguousSessionKeys.add(sessionKey);
  const packetCosts: PacketCostSummary[] = [];
  const attributedSessionCosts: AttributedSessionCost[] = [];
  for (const packet of state.packets) {
    const resolved = await resolvePacketTelemetry(
      packet,
      cache,
      claimedSessionKeys,
      ambiguousSessionKeys,
      laneByPacketId,
    );
    packetCosts.push(resolved.packetCost);
    attributedSessionCosts.push(...resolved.sessionCosts);
  }
  for (const sessionKey of ambiguousSessionKeys) {
    const runtime = runtimeFromSessionKey(sessionKey)
      ?? [...laneByPacketId?.values() ?? []]
        .flatMap((entry) => Array.isArray(entry) ? entry : [entry])
        .find((entry) => entry.sessionKey === sessionKey)?.runtime;
    if (!runtime) continue;
    if (crossMissionSessionKeys.has(sessionKey)) {
      attributedSessionCosts.push({
        identityId: null,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        model: null,
        hasTelemetry: false,
        costSource: 'unknown',
        costByRole: emptyCostByRole(),
        packetId: null,
        sessionKey,
        runtime,
      });
      continue;
    }
    const telemetry = await resolveSessionTelemetry(sessionKey, runtime, cache);
    attributedSessionCosts.push({ ...telemetry, packetId: null, sessionKey, runtime });
  }

  const tokensByRuntime = Object.fromEntries(
    ORCHESTRATOR_RUNTIME_IDS.map((runtime) => [runtime, emptyRuntimeTokenSummary()]),
  ) as Record<OrchestratorRuntime, RuntimeTokenSummary>;

  let totalCostUsd = 0;
  const unattributed = {
    sessionCount: 0,
    unknownSessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
  };
  const costByRole = emptyCostByRole();
  const countedPacketRuntimes = new Set<string>();

  for (const sessionCost of attributedSessionCosts) {
    totalCostUsd += sessionCost.totalCostUsd;
    for (const [role, subtotal] of Object.entries(sessionCost.costByRole) as Array<[UsageRole, RoleCostSummary]>) {
      const roleTotal = costByRole[role];
      roleTotal.inputTokens += subtotal.inputTokens;
      roleTotal.outputTokens += subtotal.outputTokens;
      roleTotal.totalCostUsd = roundUsd(roleTotal.totalCostUsd + subtotal.totalCostUsd);
      roleTotal.requestCount += subtotal.requestCount;
    }

    if (sessionCost.packetId === null) {
      unattributed.sessionCount += 1;
      if (crossMissionSessionKeys.has(sessionCost.sessionKey)) unattributed.unknownSessionCount += 1;
      unattributed.inputTokens += sessionCost.inputTokens;
      unattributed.outputTokens += sessionCost.outputTokens;
      unattributed.totalCostUsd = roundUsd(unattributed.totalCostUsd + sessionCost.totalCostUsd);
    }

    if (!sessionCost.hasTelemetry) {
      continue;
    }

    const runtimeTotals = tokensByRuntime[sessionCost.runtime];
    runtimeTotals.inputTokens += sessionCost.inputTokens;
    runtimeTotals.outputTokens += sessionCost.outputTokens;
    runtimeTotals.totalCostUsd = roundUsd(runtimeTotals.totalCostUsd + sessionCost.totalCostUsd);
    const packetRuntimeKey = sessionCost.packetId === null
      ? null
      : `${sessionCost.packetId}\0${sessionCost.runtime}`;
    if (packetRuntimeKey && !countedPacketRuntimes.has(packetRuntimeKey)) {
      countedPacketRuntimes.add(packetRuntimeKey);
      runtimeTotals.packetCount += 1;
    }
  }

  return {
    totalCostUsd: roundUsd(totalCostUsd),
    packetCosts,
    tokensByRuntime,
    costByRole,
    unattributed,
  };
}
