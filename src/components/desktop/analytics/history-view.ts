import type { HistoryBucket, UsageProviderKind } from '@/lib/usage/history-types';
import { EMPTY_TOTALS, totalTokens } from '@/lib/usage/history-readers/usageTranscripts';
export const providers: { id: UsageProviderKind; name: string; color: string }[] = [
  { id: 'codex', name: 'Codex', color: 'var(--t-text)' },
  { id: 'claude', name: 'Claude Code', color: 'var(--t-brand-orange)' },
  { id: 'grok', name: 'Grok Build', color: 'var(--t-text-secondary)' },
  { id: 'opencode', name: 'OpenCode', color: 'var(--t-accent)' },
  { id: 'antigravity', name: 'Antigravity', color: 'var(--t-terminal-ansi-magenta)' },
];
export const money = (value: number) => value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
export const count = (value: number) => value.toLocaleString(undefined, { notation: value >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 2 });
export function sumBuckets(buckets: HistoryBucket[]) {
  const totals = { ...EMPTY_TOTALS }; let cost = 0; let savings = 0; let unpriced = 0; let records = 0; let fast = 0; let premium = 0;
  const categories = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const bucket of buckets) {
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += bucket.totals[key];
    for (const key of Object.keys(categories) as (keyof typeof categories)[]) categories[key] += bucket.categoryCostUsd[key];
    cost += bucket.costUsd; savings += bucket.cacheSavingsUsd; unpriced += bucket.unpricedRecords; records += bucket.records;
    fast += bucket.fastCostUsd; premium += bucket.speedPremiumUsd;
  }
  return { totals, tokens: totalTokens(totals), cost, savings, unpriced, records, fast, premium, categories };
}
