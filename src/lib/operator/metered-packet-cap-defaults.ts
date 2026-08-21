export interface MeteredPacketCapDefaults {
  meteredPacketCostCapUsd: number;
  meteredPacketInputTokenCap: number;
}
export const METERED_PACKET_CAP_FALLBACK: MeteredPacketCapDefaults = {
  meteredPacketCostCapUsd: 1,
  meteredPacketInputTokenCap: 500_000,
};

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveStoredMeteredPacketCap(value: Partial<MeteredPacketCapDefaults>): Partial<MeteredPacketCapDefaults> {
  const costUsd = positiveNumber(value.meteredPacketCostCapUsd);
  const inputTokens = positiveNumber(value.meteredPacketInputTokenCap);
  return {
    ...(costUsd === undefined ? {} : { meteredPacketCostCapUsd: costUsd }),
    ...(inputTokens === undefined ? {} : { meteredPacketInputTokenCap: Math.round(inputTokens) }),
  };
}

export function resolveMeteredPacketCapSettings(file: Partial<MeteredPacketCapDefaults>) {
  const costUsd = positiveNumber(file.meteredPacketCostCapUsd);
  const inputTokens = positiveNumber(file.meteredPacketInputTokenCap);
  return {
    values: {
      meteredPacketCostCapUsd: costUsd ?? METERED_PACKET_CAP_FALLBACK.meteredPacketCostCapUsd,
      meteredPacketInputTokenCap: Math.round(inputTokens ?? METERED_PACKET_CAP_FALLBACK.meteredPacketInputTokenCap),
    },
    sources: {
      meteredPacketCostCapUsd: costUsd === undefined ? 'default' as const : 'file' as const,
      meteredPacketInputTokenCap: inputTokens === undefined ? 'default' as const : 'file' as const,
    },
  };
}

export function applyMeteredPacketCapUpdate(stored: Partial<MeteredPacketCapDefaults>, update: Partial<MeteredPacketCapDefaults>): void {
  if (update.meteredPacketCostCapUsd !== undefined) {
    if (!positiveNumber(update.meteredPacketCostCapUsd)) throw new Error('meteredPacketCostCapUsd must be greater than 0.');
    stored.meteredPacketCostCapUsd = update.meteredPacketCostCapUsd;
  }
  if (update.meteredPacketInputTokenCap !== undefined) {
    if (!positiveNumber(update.meteredPacketInputTokenCap)) throw new Error('meteredPacketInputTokenCap must be greater than 0.');
    stored.meteredPacketInputTokenCap = Math.round(update.meteredPacketInputTokenCap);
  }
}
