import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { registerCostParser } from '@/lib/runtimes/shared/cost-parser-registry';
import type { SessionCostData } from '@/lib/runtimes/shared/cost-parser-registry';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function readUsage(parsed: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(parsed.usage)) return parsed.usage;
  if (isRecord(parsed.stats)) return parsed.stats;
  const data = isRecord(parsed.data) ? parsed.data : null;
  if (data && isRecord(data.tokens)) return data.tokens;
  return null;
}

/**
 * Conservative v1 parser. prime-agent's RPC-mode `get_session_stats`
 * response has a confirmed token shape (see the docs cited in owned.ts), but
 * json mode — what v1 launches with — has no confirmed per-turn usage
 * event. This reads whatever usage/stats fields do show up on any line and
 * never invents a cost estimate: the operator's own provider/model choice
 * means o8 has no pricing table to compute one from (unlike e.g. Grok Build,
 * which is billed on one fixed known plan).
 */
function extractUsage(parsed: Record<string, unknown>): SessionCostData | null {
  const usage = readUsage(parsed);
  if (!usage) return null;
  const inputTokens = toNumber(usage.input_tokens ?? usage.inputTokens ?? usage.input);
  const outputTokens = toNumber(usage.output_tokens ?? usage.outputTokens ?? usage.output);
  const cacheReadTokens = toNumber(usage.cache_read_tokens ?? usage.cacheReadTokens ?? usage.cacheRead);
  const cacheWriteTokens = toNumber(usage.cache_write_tokens ?? usage.cacheWriteTokens ?? usage.cacheWrite);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return null;
  const totalCostUsd = toNumber(usage.total_cost_usd ?? usage.totalCostUsd ?? usage.cost ?? parsed.cost);
  const model = typeof parsed.model === 'string' && parsed.model.trim()
    ? parsed.model.trim()
    : typeof usage.model === 'string' && usage.model.trim()
      ? usage.model.trim()
      : null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCostUsd, model };
}

async function parsePrimeAgentCostFile(filePath: string): Promise<SessionCostData | null> {
  const exists = await access(filePath).then(() => true).catch(() => false);
  if (!exists) return null;
  const reader = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let last: SessionCostData | null = null;
  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      last = extractUsage(JSON.parse(trimmed) as Record<string, unknown>) ?? last;
    } catch {
      continue;
    }
  }
  return last;
}

export async function parsePrimeAgentSessionCost(paths: string[]): Promise<SessionCostData> {
  const totals: SessionCostData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    model: null,
  };
  const models = new Set<string>();
  for (const filePath of paths) {
    const parsed = await parsePrimeAgentCostFile(filePath);
    if (!parsed) continue;
    totals.inputTokens += parsed.inputTokens;
    totals.outputTokens += parsed.outputTokens;
    totals.cacheReadTokens += parsed.cacheReadTokens;
    totals.cacheWriteTokens += parsed.cacheWriteTokens;
    totals.totalCostUsd += parsed.totalCostUsd;
    if (parsed.model) models.add(parsed.model);
  }
  totals.totalCostUsd = Number(totals.totalCostUsd.toFixed(6));
  totals.model = models.size === 1 ? [...models][0] : models.size > 1 ? 'mixed' : null;
  return totals;
}

registerCostParser({
  runtimeId: 'prime-agent',
  parseFiles: parsePrimeAgentSessionCost,
});
