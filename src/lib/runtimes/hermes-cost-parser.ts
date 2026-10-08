import { registerCostParser, type SessionCostData } from '@/lib/runtimes/shared/cost-parser-registry';

/** Hermes context-size notifications are not token or provider-charge receipts. */
export async function parseHermesSessionCost(
  _paths: string[],
  opts?: { fallbackModel?: string | null },
): Promise<SessionCostData> {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    model: opts?.fallbackModel ?? null,
    costSource: 'unknown',
  };
}

registerCostParser({ runtimeId: 'hermes', parseFiles: parseHermesSessionCost });
