import type { HistoryBucket, HistorySource, UsageHistorySummary, UsageProviderKind } from './history-types';

const providers: UsageProviderKind[] = ['codex', 'claude', 'grok', 'opencode', 'antigravity'];
const tokenKeys = ['uncachedInputTokens', 'cachedInputTokens', 'cacheCreationTokens', 'outputTokens', 'reasoningTokens'] as const;
const costKeys = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid machine usage.');
  return value as Record<string, unknown>;
}
function number(value: unknown, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new Error('Invalid machine usage.');
  return value;
}
function provider(value: unknown): UsageProviderKind {
  if (!providers.includes(value as UsageProviderKind)) throw new Error('Invalid machine provider.');
  return value as UsageProviderKind;
}
function numericObject<K extends string>(value: unknown, keys: readonly K[], integer = false): Record<K, number> {
  const input = record(value);
  return Object.fromEntries(keys.map(key => [key, number(input[key], integer)])) as Record<K, number>;
}
/** Project exact public fields instead of forwarding an untrusted remote object's extras. */
export function validateRemoteHistory(value: unknown, input: { days: number; timeZone: string }, pricing: UsageHistorySummary['pricing']): UsageHistorySummary {
  const data = record(value);
  if (data.schema !== 'o8/usage-history/v1' || data.timeZone !== input.timeZone || !Array.isArray(data.buckets)
    || data.buckets.length > 50_000 || !Array.isArray(data.sources) || data.sources.length > providers.length
    || typeof data.observedAt !== 'string' || !Number.isFinite(Date.parse(data.observedAt))) throw new Error('Invalid machine usage response.');
  const since = number(data.since); const until = number(data.until);
  if (since > until || until - since > (input.days + 2) * 86_400_000) throw new Error('Invalid machine usage window.');
  const buckets: HistoryBucket[] = data.buckets.map(value => {
    const bucket = record(value);
    if (typeof bucket.day !== 'string' || !Number.isFinite(Date.parse(bucket.day)) || bucket.day.length > 30
      || typeof bucket.model !== 'string' || !bucket.model.length || bucket.model.length > 256) throw new Error('Invalid machine usage bucket.');
    return { day: bucket.day, model: bucket.model, provider: provider(bucket.provider),
      totals: numericObject(bucket.totals, tokenKeys, true), categoryCostUsd: numericObject(bucket.categoryCostUsd, costKeys),
      costUsd: number(bucket.costUsd), cacheSavingsUsd: number(bucket.cacheSavingsUsd), fastCostUsd: number(bucket.fastCostUsd), speedPremiumUsd: number(bucket.speedPremiumUsd),
      sessions: number(bucket.sessions, true), records: number(bucket.records, true), unpricedRecords: number(bucket.unpricedRecords, true), reportedRecords: number(bucket.reportedRecords, true) };
  });
  const sources: HistorySource[] = data.sources.map(value => {
    const source = record(value); if (!['ready', 'partial', 'missing'].includes(String(source.status))) throw new Error('Invalid machine source.');
    return { provider: provider(source.provider), status: source.status as HistorySource['status'], files: number(source.files, true), records: number(source.records, true) };
  });
  const sessions = record(data.providerSessions);
  const providerSessions = Object.fromEntries(Object.entries(sessions).map(([key, count]) => [provider(key), number(count, true)]));
  return { schema: 'o8/usage-history/v1', since, until, observedAt: data.observedAt, timeZone: input.timeZone,
    buckets, sources, providerSessions, pricing, scan: numericObject(data.scan, ['filesRead', 'bytesRead', 'durationMs']) };
}
