import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolveRate } from '@/lib/cost/rate-table';
import { registerCostParser } from '@/lib/runtimes/shared/cost-parser-registry';
import type { SessionCostData } from '@/lib/runtimes/shared/cost-parser-registry';

const TOKENS_PER_MILLION = 1_000_000;
const DEFAULT_MODEL = 'cursor-agent';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function readUsage(parsed: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(parsed.usage)) return parsed.usage;
  if (isRecord(parsed.stats)) return parsed.stats;
  return null;
}

function readModel(parsed: Record<string, unknown>, usage: Record<string, unknown> | null): string | null {
  const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
  if (model) return model;
  const usageModel = typeof usage?.model === 'string' ? usage.model.trim() : '';
  return usageModel || null;
}

function extractUsage(parsed: Record<string, unknown>): SessionCostData | null {
  const type = String(parsed.type ?? parsed.event ?? '').toLowerCase();
  const usage = readUsage(parsed);
  if (!usage && type !== 'usage' && type !== 'cost') return null;
  const source = usage ?? parsed;
  const inputTokens = toNumber(source.input_tokens ?? source.inputTokens ?? source.prompt_tokens ?? source.promptTokens);
  const outputTokens = toNumber(source.output_tokens ?? source.outputTokens ?? source.completion_tokens ?? source.completionTokens);
  const cacheReadTokens = toNumber(source.cache_read_tokens ?? source.cacheReadTokens ?? source.cached_input_tokens ?? source.cachedInputTokens);
  const cacheWriteTokens = toNumber(source.cache_write_tokens ?? source.cacheWriteTokens);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return null;
  const embeddedCost = toNumber(source.total_cost_usd ?? source.totalCostUsd ?? source.cost_usd ?? source.costUsd);
  const rate = resolveRate('cursor', readModel(parsed, usage));
  const computedCost = (
    (inputTokens * (rate?.inputUsdPerMillion ?? 0))
    + (cacheWriteTokens * (rate?.cacheWriteUsdPerMillion ?? 0))
    + (outputTokens * (rate?.outputUsdPerMillion ?? 0))
  ) / TOKENS_PER_MILLION;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalCostUsd: Number((embeddedCost || computedCost).toFixed(6)),
    model: readModel(parsed, usage) ?? DEFAULT_MODEL,
    costSource: embeddedCost > 0 ? 'gateway' : 'estimate',
  };
}

async function parseCursorCostFile(filePath: string): Promise<SessionCostData | null> {
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

export async function parseCursorSessionCost(paths: string[]): Promise<SessionCostData> {
  const totals: SessionCostData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    model: null,
  };
  const models = new Set<string>();
  let usedEstimate = false;
  let usedGateway = false;
  for (const filePath of paths) {
    const parsed = await parseCursorCostFile(filePath);
    if (!parsed) continue;
    totals.inputTokens += parsed.inputTokens;
    totals.outputTokens += parsed.outputTokens;
    totals.cacheReadTokens += parsed.cacheReadTokens;
    totals.cacheWriteTokens += parsed.cacheWriteTokens;
    totals.totalCostUsd += parsed.totalCostUsd;
    usedEstimate ||= parsed.costSource === 'estimate';
    usedGateway ||= parsed.costSource === 'gateway';
    if (parsed.model) models.add(parsed.model);
  }
  totals.totalCostUsd = Number(totals.totalCostUsd.toFixed(6));
  totals.model = models.size === 1 ? [...models][0] : models.size > 1 ? 'mixed' : DEFAULT_MODEL;
  totals.costSource = usedEstimate ? 'estimate' : usedGateway ? 'gateway' : 'unknown';
  return totals;
}

registerCostParser({
  runtimeId: 'cursor',
  parseFiles: parseCursorSessionCost,
});
