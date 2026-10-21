import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '@/lib/data-dir-migration';
import { boundedMuseRequest, createMuseHost } from './host';
import { museRecord } from './protocol';

export interface MuseModel {
  id: string;
  label: string;
  provider: string;
  isDefault: boolean;
  efforts: string[];
}

export interface MuseModelCatalog {
  models: MuseModel[];
  observedAt: string;
  source: 'probe' | 'cache';
  authStatus: 'unknown';
}

const inFlight = new Map<string, Promise<MuseModelCatalog>>();
const validEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function decodeMuseModels(value: unknown): MuseModel[] {
  const data = museRecord(value);
  if (data.providerId !== 'meta' || !Array.isArray(data.models)) throw new Error('Muse returned an incompatible model catalog.');
  const seen = new Set<string>();
  return data.models.flatMap(value => {
    const row = museRecord(value);
    if (row.providerId !== 'meta' || typeof row.modelId !== 'string' || !row.modelId.trim() || seen.has(row.modelId)) return [];
    seen.add(row.modelId);
    return [{ id: row.modelId, label: typeof row.displayLabel === 'string' ? row.displayLabel : row.modelId,
      provider: 'meta', isDefault: row.isDefault === true,
      efforts: Array.isArray(row.variants) ? row.variants.filter((value): value is string => typeof value === 'string' && validEfforts.has(value)) : [] }];
  });
}

/** Discovery executes no turn and never promotes catalog presence into login evidence. */
export async function probeMuseModels(cwd: string, force = false): Promise<MuseModelCatalog> {
  const cache = join(getDataDir(), 'muse', 'models.json');
  if (!force) {
    const saved = await readFile(cache, 'utf8').then(raw => JSON.parse(raw) as MuseModelCatalog).catch(() => null);
    if (saved && Array.isArray(saved.models) && Date.now() - Date.parse(saved.observedAt) < 15 * 60_000) return { ...saved, source: 'cache', authStatus: 'unknown' };
  }
  const key = cwd;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const host = await createMuseHost({ cwd, readOnly: true });
    try {
      const models = decodeMuseModels(await boundedMuseRequest(host.connection.request('model/list', {}), host));
      const result: MuseModelCatalog = { models, observedAt: new Date().toISOString(), source: 'probe', authStatus: 'unknown' };
      await mkdir(dirname(cache), { recursive: true });
      const temporary = `${cache}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
      await rename(temporary, cache);
      return result;
    } finally { await host.close(); }
  })();
  inFlight.set(key, promise);
  try { return await promise; } finally { if (inFlight.get(key) === promise) inFlight.delete(key); }
}
