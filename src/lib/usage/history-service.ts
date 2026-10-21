import 'server-only';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { readHistoryPricing } from './history-pricing';
import { resolveHistoryRoots } from './history-roots';
import { createHistoryReader as createReader } from './history-reader';
import type { UsageHistorySummary } from './history-types';
export { aggregateHistory } from './history-reader';

export function createHistoryReader(options: Omit<Parameters<typeof createReader>[0], 'pricing'> & { pricing?: typeof readHistoryPricing }) {
  return createReader({ ...options, pricing: options.pricing ?? readHistoryPricing });
}
interface HistoryJob { snapshot: UsageHistorySummary | null; pending: boolean; startedAt: number; error: boolean }
// Development module replacement must not launch another scan for each poll.
const host = globalThis as typeof globalThis & { __o8UsageHistoryV1?: { reader: ReturnType<typeof createHistoryReader> | null; jobs: Map<string, HistoryJob> } };
const state = host.__o8UsageHistoryV1 ??= { reader: null, jobs: new Map() };
export function readUsageHistory(input: Parameters<ReturnType<typeof createHistoryReader>>[0]) {
  state.reader ??= createHistoryReader({ roots: resolveHistoryRoots, cacheDirectory: join(getDataDir(), 'usage-history') });
  return state.reader(input);
}

const jobs = state.jobs;
/** Long first scans stay in the local server; callers poll without holding an HTTP connection open. */
export function getUsageHistoryState(input: Parameters<typeof readUsageHistory>[0]) {
  const key = `${input.days}:${input.timeZone}`;
  let job = jobs.get(key);
  if (!job) { job = { snapshot: null, pending: false, startedAt: 0, error: false }; jobs.set(key, job); }
  const elapsed = Date.now() - job.startedAt;
  if (!job.pending && (elapsed > 60_000 || (!job.snapshot && !job.error) || (input.fresh && elapsed > 1_000))) {
    job.pending = true; job.error = false; job.startedAt = Date.now();
    const current = job;
    void readUsageHistory(input).then(snapshot => { current.snapshot = snapshot; })
      .catch(() => { current.error = true; }).finally(() => { current.pending = false; });
  }
  if (jobs.size > 24) for (const [otherKey, other] of jobs) {
    if (otherKey !== key && !other.pending) { jobs.delete(otherKey); break; }
  }
  return job;
}
