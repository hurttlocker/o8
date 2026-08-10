import { getRuntime } from '@/lib/runtimes';
import type { OrchestratorMissionState, OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';

export interface PacketCostSummary {
  packetId: string;
  sessionKey: string | null;
  runtime: OrchestratorRuntime;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  hasTelemetry: boolean;
}

export interface RuntimeTokenSummary {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  packetCount: number;
}

export interface MissionCostSummary {
  totalCostUsd: number;
  packetCosts: PacketCostSummary[];
  tokensByRuntime: Record<OrchestratorRuntime, RuntimeTokenSummary>;
}

type CachedTelemetrySummary = {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  model: string | null;
  hasTelemetry: boolean;
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

function buildEmptyPacketCostSummary(packet: OrchestratorPacket): PacketCostSummary {
  return {
    packetId: packet.id,
    sessionKey: packet.lane?.sessionKey?.trim() || null,
    runtime: packet.lane?.runtime ?? packet.runtime,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
    hasTelemetry: false,
  };
}

function runtimeFromSessionKey(sessionKey: string | null | undefined): OrchestratorRuntime | null {
  const normalized = sessionKey?.trim() ?? '';
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith('claude-code:')) {
    return 'claude-code';
  }
  if (
    normalized.startsWith('codex:')
    || normalized.startsWith('codex-owned:')
    || normalized.startsWith('codex-discovered:')
  ) {
    return 'codex';
  }
  if (normalized.startsWith('gemini:')) {
    return 'gemini';
  }
  if (normalized.startsWith('opencode:')) {
    return 'opencode';
  }
  return null;
}

async function resolvePacketTelemetry(
  packet: OrchestratorPacket,
  cache: Map<string, CachedTelemetrySummary>,
): Promise<PacketCostSummary> {
  const fallback = buildEmptyPacketCostSummary(packet);
  const sessionKey = fallback.sessionKey;
  if (!sessionKey) {
    return fallback;
  }

  const runtime = runtimeFromSessionKey(sessionKey) ?? packet.lane?.runtime ?? packet.runtime;
  const cached = cache.get(sessionKey);
  if (cached) {
    return {
      ...fallback,
      runtime,
      ...cached,
    };
  }

  const adapter = getRuntime(runtime);
  if (!adapter?.capabilities.costTelemetry || !adapter.getTelemetry) {
    return {
      ...fallback,
      runtime,
    };
  }

  try {
    const telemetry = await adapter.getTelemetry(sessionKey);
    if (!telemetry) {
      const empty = {
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        model: null,
        hasTelemetry: false,
      } satisfies CachedTelemetrySummary;
      cache.set(sessionKey, empty);
      return {
        ...fallback,
        runtime,
        ...empty,
      };
    }

    const next = {
      inputTokens: toFiniteNumber(telemetry.inputTokens),
      outputTokens: toFiniteNumber(telemetry.outputTokens),
      totalCostUsd: roundUsd(toFiniteNumber(telemetry.estimatedCostUsd)),
      model: telemetry.model?.trim() || null,
      hasTelemetry: true,
    } satisfies CachedTelemetrySummary;
    cache.set(sessionKey, next);

    return {
      ...fallback,
      runtime,
      ...next,
    };
  } catch (error) {
    console.error(`[cost-agg] Failed to load telemetry for packet ${packet.id} (${sessionKey}).`, error);
    return {
      ...fallback,
      runtime,
    };
  }
}

export async function aggregateMissionCost(state: OrchestratorMissionState): Promise<MissionCostSummary> {
  const cache = new Map<string, CachedTelemetrySummary>();
  const packetCosts = await Promise.all(state.packets.map((packet) => resolvePacketTelemetry(packet, cache)));

  const tokensByRuntime: Record<OrchestratorRuntime, RuntimeTokenSummary> = {
    codex: emptyRuntimeTokenSummary(),
    'claude-code': emptyRuntimeTokenSummary(),
    gemini: emptyRuntimeTokenSummary(),
    antigravity: emptyRuntimeTokenSummary(),
    opencode: emptyRuntimeTokenSummary(),
    openhands: emptyRuntimeTokenSummary(),
    goose: emptyRuntimeTokenSummary(),
    qwen: emptyRuntimeTokenSummary(),
    qoder: emptyRuntimeTokenSummary(),
    kimi: emptyRuntimeTokenSummary(),
    aider: emptyRuntimeTokenSummary(),
    '3code': emptyRuntimeTokenSummary(),
    cursor: emptyRuntimeTokenSummary(),
    grok: emptyRuntimeTokenSummary(),
    pi: emptyRuntimeTokenSummary(),
    'prime-agent': emptyRuntimeTokenSummary(),
  };

  let totalCostUsd = 0;

  for (const packetCost of packetCosts) {
    totalCostUsd += packetCost.totalCostUsd;

    if (!packetCost.hasTelemetry) {
      continue;
    }

    const runtimeTotals = tokensByRuntime[packetCost.runtime];
    runtimeTotals.inputTokens += packetCost.inputTokens;
    runtimeTotals.outputTokens += packetCost.outputTokens;
    runtimeTotals.totalCostUsd = roundUsd(runtimeTotals.totalCostUsd + packetCost.totalCostUsd);
    runtimeTotals.packetCount += 1;
  }

  return {
    totalCostUsd: roundUsd(totalCostUsd),
    packetCosts,
    tokensByRuntime,
  };
}
