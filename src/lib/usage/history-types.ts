export type UsageProviderKind = 'claude' | 'codex' | 'grok' | 'cursor' | 'opencode' | 'antigravity';
export type UsageCostSource = 'providerReported' | 'modelPriced' | 'unpriced';
export interface UsageTokenTotals {
  uncachedInputTokens: number; cachedInputTokens: number; cacheCreationTokens: number;
  outputTokens: number; reasoningTokens: number;
}
export interface UsageCategoryCost { input: number; cacheRead: number; cacheWrite: number; output: number }
export interface UsageModelPriceOverride {
  inputCostPerMillionTokens: number; outputCostPerMillionTokens: number;
  cacheReadCostPerMillionTokens?: number; cacheWriteCostPerMillionTokens?: number;
}
export interface HistoryBucket {
  day: string; provider: UsageProviderKind; model: string; totals: UsageTokenTotals;
  costUsd: number; cacheSavingsUsd: number; categoryCostUsd: UsageCategoryCost;
  sessions: number; records: number; unpricedRecords: number; reportedRecords: number;
  fastCostUsd: number; speedPremiumUsd: number;
}
export interface HistorySource {
  provider: UsageProviderKind; status: 'ready' | 'missing' | 'partial'; files: number; records: number;
}
export interface UsageHistorySummary {
  schema: 'o8/usage-history/v1'; observedAt: string; since: number; until: number; timeZone: string;
  buckets: HistoryBucket[]; sources: HistorySource[]; providerSessions: Partial<Record<UsageProviderKind, number>>;
  pricing: { source: string; observedAt: string | null; status: 'live' | 'cached' | 'bundled' };
  scan: { filesRead: number; bytesRead: number; durationMs: number };
}
