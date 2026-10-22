import { lstatSync } from 'node:fs';
import { readPiFile, PI_SESSION_COPY_BYTES } from '@/lib/pi/user-setup';
import { formatClock } from '@/lib/runtimes/shared/owned-session';
import type { RuntimeTelemetry } from '@/lib/runtimes/types';
import type { OwnedTailEntry } from '@/lib/runtimes/shared/owned-session/types';

export interface PiRunUsage {
  sessionFile?: string;
  startByte?: number;
  endByte?: number;
  modelUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null; model?: string };
  cacheWarming?: { refreshes: number; costUsd: number | null };
}

export async function startPiRunUsage(sessionFile?: string): Promise<PiRunUsage> {
  if (!sessionFile) return { startByte: 0 };
  const bytes = await readPiFile(sessionFile, PI_SESSION_COPY_BYTES);
  return { sessionFile, startByte: bytes?.length };
}

// A run is settled once. Idle warming after agent_end belongs to no active run
// and must not alter an already issued receipt on the next transcript poll.
const pending = new WeakMap<PiRunUsage, Promise<void>>();
export function finishPiRunUsage(usage: PiRunUsage | undefined): Promise<void> {
  if (!usage?.sessionFile || usage.startByte === undefined || usage.cacheWarming) return Promise.resolve();
  const current = pending.get(usage);
  if (current) return current;
  if (usage.endByte === undefined) {
    try {
      const info = lstatSync(usage.sessionFile);
      if (!info.isFile() || info.size < usage.startByte || info.size > PI_SESSION_COPY_BYTES) return Promise.resolve();
      usage.endByte = info.size;
    } catch { return Promise.resolve(); }
  }
  const request = captureUsage(usage).catch(() => undefined).finally(() => pending.delete(usage));
  pending.set(usage, request);
  return request;
}

async function captureUsage(usage: PiRunUsage) {
  const bytes = await readPiFile(usage.sessionFile!, usage.endByte!, true);
  if (!bytes || bytes.length !== usage.endByte) return;
  const seen = new Set<string>();
  let refreshes = 0;
  let costUsd: number | null = 0;
  const modelUsage: NonNullable<PiRunUsage['modelUsage']> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  const tokens = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const addCost = (total: number | null, value: unknown) => total !== null && typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isFinite(total + value) ? total + value : null;
  for (const line of bytes.subarray(usage.startByte).toString('utf8').split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.id !== 'string' || seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (entry.type === 'usage' && entry.kind === 'cache_warm') {
        refreshes += 1;
        costUsd = addCost(costUsd, entry.usage?.cost?.total);
      }
      if (entry.type === 'message' && entry.message?.role === 'assistant') {
        const used = entry.message.usage;
        modelUsage.inputTokens += tokens(used?.input);
        modelUsage.outputTokens += tokens(used?.output);
        modelUsage.cacheReadTokens += tokens(used?.cacheRead);
        modelUsage.cacheWriteTokens += tokens(used?.cacheWrite);
        modelUsage.costUsd = addCost(modelUsage.costUsd, used?.cost?.total);
        if (typeof entry.message.model === 'string') modelUsage.model = entry.message.model;
      }
    } catch { /* Ignore incomplete or malformed JSONL entries. */ }
  }
  usage.cacheWarming = { refreshes, costUsd };
  usage.modelUsage = modelUsage;
}

// Pi's get_session_stats includes warming and other usage categories. For runs
// with recorded boundaries, derive model telemetry from assistant entries only.
export function piRunModelTelemetry(usages: Array<PiRunUsage | undefined>): RuntimeTelemetry | undefined {
  if (!usages.length || usages.some(usage => !usage?.modelUsage)) return undefined;
  const models = usages.map(usage => usage!.modelUsage!);
  const costKnown = models.every(model => model.costUsd !== null);
  const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => models.reduce((total, model) => total + model[key], 0);
  return {
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'),
    totalTokens: sum('inputTokens') + sum('outputTokens'),
    estimatedCostUsd: costKnown ? models.reduce((total, model) => total + model.costUsd!, 0) : undefined,
    costSource: costKnown ? 'gateway' : 'unknown', model: models.findLast(model => model.model)?.model,
  };
}

export function piCacheWarmingReceipt(run: {
  id: string; startedAt: string; finishedAt?: string; usage?: PiRunUsage;
}): OwnedTailEntry | null {
  const warming = run.usage?.cacheWarming;
  if (!warming?.refreshes) return null;
  const cost = warming.costUsd === null ? 'cost unavailable' : `$${warming.costUsd.toFixed(4)}`;
  return {
    id: `${run.id}:cache-warming`, kind: 'event', label: 'Cache warming',
    text: `Cache warming: ${warming.refreshes} ${warming.refreshes === 1 ? 'refresh' : 'refreshes'} · ${cost}`,
    timestamp: run.finishedAt ?? run.startedAt,
    timestampLabel: formatClock(run.finishedAt ?? run.startedAt),
  };
}
