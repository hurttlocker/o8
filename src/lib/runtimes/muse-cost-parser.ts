import { registerCostParser, type SessionCostData } from './shared/cost-parser-registry';

/** Session activity is not an account-capacity or charge receipt. */
export async function parseMuseSessionCost(_paths: string[], options?: { fallbackModel?: string | null }): Promise<SessionCostData> {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalCostUsd: 0, model: options?.fallbackModel ?? null, costSource: 'unknown' };
}
registerCostParser({ runtimeId: 'muse', parseFiles: parseMuseSessionCost });
