import type { HistoryBucket, UsageProviderKind } from '@/lib/usage/history-types';
import { providers, sumBuckets } from './history-view';

export interface UsageChartPoint { day: string; values: Partial<Record<UsageProviderKind, number>> }
export function usageChartPoints(buckets: HistoryBucket[], mode: 'cost' | 'tokens', since: number, until: number, hourly: boolean, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = (time: number) => {
    const parts = formatter.formatToParts(time);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
  };
  const keys = new Set<string>();
  const start = hourly ? Math.floor(since / 3_600_000) * 3_600_000 : Date.parse(`${dayKey(since)}T12:00:00Z`);
  const end = hourly ? until : Date.parse(`${dayKey(until)}T12:00:00Z`);
  for (let time = start; time <= end; time += hourly ? 3_600_000 : 86_400_000) {
    keys.add(hourly ? new Date(time).toISOString() : new Date(time).toISOString().slice(0, 10));
  }
  for (const bucket of buckets) keys.add(bucket.day);
  return [...keys].sort().map(day => ({ day, values: Object.fromEntries(providers.map(provider => {
    const sum = sumBuckets(buckets.filter(bucket => bucket.day === day && bucket.provider === provider.id));
    return [provider.id, mode === 'cost' ? sum.cost : sum.tokens];
  })) }));
}

/** Round tick steps, rather than displaying arbitrary observed maxima. */
export function usageChartTicks(maximum: number) {
  if (maximum <= 0) return [0, 1];
  const rough = maximum / 3; const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find(value => value >= rough / power) ?? 10) * power;
  return Array.from({ length: Math.ceil(maximum / step) + 1 }, (_, index) => index * step);
}
