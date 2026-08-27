import type { LaneEvent } from '@/lib/lane/types';

export interface PacketContextObservation {
  inputTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
  sourceEventId: string;
  observedAt: string;
}

export interface PacketContextTelemetry extends PacketContextObservation {
  contextDeltaTokens: number | null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

export function packetContextObservationFromEvent(event: LaneEvent): PacketContextObservation | undefined {
  if (event.verb !== 'runtime_process_exit') return undefined;
  const inputTokens = tokenCount(event.payload.inputTokens);
  const cacheReadTokens = tokenCount(event.payload.cacheReadTokens);
  if (inputTokens === null || cacheReadTokens === null) return undefined;
  const contextTokens = tokenCount(event.payload.contextTokens) ?? inputTokens + cacheReadTokens;
  if (contextTokens <= 0) return undefined;
  return {
    inputTokens,
    cacheReadTokens,
    contextTokens,
    sourceEventId: event.id,
    observedAt: event.timestamp,
  };
}

export function normalizePacketContextTelemetry(value: unknown): PacketContextTelemetry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<PacketContextTelemetry>;
  const inputTokens = tokenCount(raw.inputTokens);
  const cacheReadTokens = tokenCount(raw.cacheReadTokens);
  const contextTokens = tokenCount(raw.contextTokens);
  const contextDeltaTokens = raw.contextDeltaTokens === null
    ? null
    : typeof raw.contextDeltaTokens === 'number' && Number.isFinite(raw.contextDeltaTokens)
      ? Math.round(raw.contextDeltaTokens)
      : null;
  if (inputTokens === null || cacheReadTokens === null || contextTokens === null || contextTokens <= 0) {
    return undefined;
  }
  if (typeof raw.sourceEventId !== 'string' || !raw.sourceEventId.trim()) return undefined;
  if (typeof raw.observedAt !== 'string' || !raw.observedAt.trim()) return undefined;
  return {
    inputTokens,
    cacheReadTokens,
    contextTokens,
    contextDeltaTokens,
    sourceEventId: raw.sourceEventId.trim(),
    observedAt: raw.observedAt,
  };
}

export function reconcilePacketContextTelemetry(
  current: PacketContextTelemetry | undefined,
  observation: PacketContextObservation | undefined,
): PacketContextTelemetry | undefined {
  if (!observation) return current;
  if (current?.sourceEventId === observation.sourceEventId) return current;
  return {
    ...observation,
    contextDeltaTokens: current ? observation.contextTokens - current.contextTokens : null,
  };
}
