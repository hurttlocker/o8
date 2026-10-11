import { homedir, hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { createHistoryReader } from './history-reader';
import { resolveHistoryRoots } from './history-roots';
import type { HistoryPricing } from './history-pricing';
import type { ModelRate } from './history-readers/usagePricing';
import { cleanupUsageDatabaseSnapshots } from './history-readers/readonlyDatabase';

/** Streamed over an operator's saved SSH connection. Never installs o8 or modifies native stores. */
export async function collectRemoteUsage(input: { days: 1 | 7 | 30 | 90; timeZone: string;
  rates: [string, ModelRate][]; pricing: HistoryPricing['meta'] }) {
  const stop = () => { void cleanupUsageDatabaseSnapshots().finally(() => process.exit(1)); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, stop);
  const identities = async (runtime: string): Promise<{ configHomeRef: string }[]> => {
    // Injected resolution skips the normal first-run data directory migration.
    const dataDir = getDataDir({ ...process.env }, homedir());
    try {
      const catalog = JSON.parse(await readFile(join(dataDir, 'runtime-identities.json'), 'utf8'));
      if (catalog.schema !== 'o8/runtime-identities/v1' || !Array.isArray(catalog.identities)) return [];
      return catalog.identities.filter((identity: { runtime?: string; configHomeRef?: unknown }) =>
        identity.runtime === runtime && typeof identity.configHomeRef === 'string');
    } catch { return []; }
  };
  const reader = createHistoryReader({ roots: () => resolveHistoryRoots({ identities }),
    pricing: async () => ({ table: new Map(input.rates), meta: input.pricing, at: Date.now() }) });
  try { const snapshot = await reader(input); return { ...snapshot, hostname: hostname() }; }
  finally { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, stop); await cleanupUsageDatabaseSnapshots(); }
}
