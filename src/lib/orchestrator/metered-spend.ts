export type PacketCostSource = 'gateway' | 'estimate' | 'unknown';

export interface PacketSpendCap {
  carrier: 'openrouter';
  costUsd: number;
  inputTokens: number;
}

export interface PacketSpendTelemetry {
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  costSource: PacketCostSource;
  capHit: boolean;
  updatedAt: string;
}

export function packetSpendCapBreach(
  cap: PacketSpendCap,
  telemetry: Pick<PacketSpendTelemetry, 'costUsd' | 'inputTokens'>,
): 'cost' | 'input_tokens' | null {
  if (telemetry.costUsd !== null) return telemetry.costUsd >= cap.costUsd ? 'cost' : null;
  return telemetry.inputTokens >= cap.inputTokens ? 'input_tokens' : null;
}

export function normalizePacketSpendCap(value: unknown): PacketSpendCap | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<PacketSpendCap>;
  if (raw.carrier !== 'openrouter') return undefined;
  if (typeof raw.costUsd !== 'number' || !Number.isFinite(raw.costUsd) || raw.costUsd <= 0) return undefined;
  if (typeof raw.inputTokens !== 'number' || !Number.isFinite(raw.inputTokens) || raw.inputTokens <= 0) return undefined;
  return { carrier: raw.carrier, costUsd: raw.costUsd, inputTokens: Math.round(raw.inputTokens) };
}

export function normalizePacketSpendTelemetry(value: unknown): PacketSpendTelemetry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<PacketSpendTelemetry>;
  if (raw.costSource !== 'gateway' && raw.costSource !== 'estimate' && raw.costSource !== 'unknown') return undefined;
  if (typeof raw.inputTokens !== 'number' || !Number.isFinite(raw.inputTokens)) return undefined;
  if (typeof raw.outputTokens !== 'number' || !Number.isFinite(raw.outputTokens)) return undefined;
  const costUsd = raw.costUsd === null
    ? null
    : typeof raw.costUsd === 'number' && Number.isFinite(raw.costUsd) && raw.costUsd >= 0
      ? raw.costUsd
      : null;
  return {
    costUsd,
    inputTokens: Math.max(0, Math.round(raw.inputTokens)),
    outputTokens: Math.max(0, Math.round(raw.outputTokens)),
    costSource: raw.costSource,
    capHit: raw.capHit === true,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
}
