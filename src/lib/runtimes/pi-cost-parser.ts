import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { registerCostParser } from '@/lib/runtimes/shared/cost-parser-registry';
import type { SessionCostData } from '@/lib/runtimes/shared/cost-parser-registry';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function readString(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function usageFromFrame(frame: Record<string, unknown>): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; model: string | null } | null {
  const data = isRecord(frame.data) ? frame.data : null;
  const stats = frame.type === 'response' && frame.command === 'get_session_stats' && data ? data : null;
  const tokens = isRecord(stats?.tokens) ? stats.tokens : null;
  if (!stats || !tokens) return null;
  return {
    input: toNumber(tokens.input ?? tokens.inputTokens),
    output: toNumber(tokens.output ?? tokens.outputTokens),
    cacheRead: toNumber(tokens.cacheRead ?? tokens.cacheReadTokens),
    cacheWrite: toNumber(tokens.cacheWrite ?? tokens.cacheWriteTokens),
    cost: toNumber(stats.cost),
    model: readString(stats, 'model', 'modelId'),
  };
}

async function parsePiFile(filePath: string) {
  const exists = await access(filePath).then(() => true).catch(() => false);
  if (!exists) return [];
  const reader = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const results: NonNullable<ReturnType<typeof usageFromFrame>>[] = [];
  for await (const rawLine of reader) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const usage = usageFromFrame(JSON.parse(trimmed) as Record<string, unknown>);
      if (usage) results.push(usage);
    } catch {
      continue;
    }
  }
  return results;
}

export async function parsePiSessionCost(
  paths: string[],
  opts?: { fallbackModel?: string | null },
): Promise<SessionCostData> {
  const parsed = (await Promise.all(paths.map(parsePiFile))).flat();
  const latest = parsed.at(-1);
  return {
    inputTokens: latest?.input ?? 0,
    outputTokens: latest?.output ?? 0,
    cacheReadTokens: latest?.cacheRead ?? 0,
    cacheWriteTokens: latest?.cacheWrite ?? 0,
    totalCostUsd: latest?.cost ?? 0,
    model: latest?.model ?? opts?.fallbackModel ?? null,
  };
}

registerCostParser({
  runtimeId: 'pi',
  parseFiles: parsePiSessionCost,
});
