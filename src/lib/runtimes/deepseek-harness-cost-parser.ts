import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import {
  deepSeekHarnessEvent,
  deepSeekHarnessEventUsage,
} from '@/lib/deepseek-harness/protocol';
import {
  registerCostParser,
  type SessionCostData,
} from '@/lib/runtimes/shared/cost-parser-registry';

async function readFileUsage(filePath: string): Promise<Array<{
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string | null;
}>> {
  if (!await access(filePath).then(() => true).catch(() => false)) return [];
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const results = [];
  for await (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame.method !== 'session.event') continue;
      const params = frame.params && typeof frame.params === 'object' && !Array.isArray(frame.params)
        ? frame.params as Record<string, unknown>
        : null;
      const event = deepSeekHarnessEvent(params);
      if (!event) continue;
      const usage = deepSeekHarnessEventUsage(event);
      if (!usage) continue;
      results.push({
        key: `${String(params?.sessionId ?? '')}:${String(event.seq ?? '')}`,
        ...usage,
      });
    } catch {
      continue;
    }
  }
  return results;
}

export async function parseDeepSeekHarnessSessionCost(
  paths: string[],
  opts?: { fallbackModel?: string | null },
): Promise<SessionCostData> {
  const seen = new Set<string>();
  const models = new Set<string>();
  const total: SessionCostData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    model: null,
  };
  for (const usage of (await Promise.all(paths.map(readFileUsage))).flat()) {
    if (seen.has(usage.key)) continue;
    seen.add(usage.key);
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    if (usage.model) models.add(usage.model);
  }
  total.model = models.size === 1
    ? [...models][0]
    : models.size > 1
      ? 'mixed'
      : opts?.fallbackModel ?? null;
  return total;
}

registerCostParser({
  runtimeId: 'deepseek-harness',
  parseFiles: parseDeepSeekHarnessSessionCost,
});
