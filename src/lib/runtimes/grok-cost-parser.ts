import { access, readFile } from 'node:fs/promises';
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
  return null;
}

function extractUsage(parsed: Record<string, unknown>): SessionCostData | null {
  const type = String(parsed.type ?? parsed.event ?? '').toLowerCase();
  const usage = readUsage(parsed);
  if (!usage && type !== 'usage' && type !== 'cost') return null;
  const source = usage ?? parsed;
  const inputTokens = toNumber(source.input_tokens ?? source.inputTokens ?? source.prompt_tokens ?? source.promptTokens);
  const outputTokens = toNumber(source.output_tokens ?? source.outputTokens ?? source.completion_tokens ?? source.completionTokens);
  const cacheReadTokens = toNumber(source.cache_read_input_tokens ?? source.cache_read_tokens ?? source.cacheReadTokens ?? source.cached_input_tokens ?? source.cachedInputTokens);
  const cacheWriteTokens = toNumber(source.cache_creation_input_tokens ?? source.cache_write_tokens ?? source.cacheWriteTokens);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return null;
  const embeddedCost = toNumber(parsed.total_cost_usd ?? parsed.totalCostUsd
    ?? source.total_cost_usd ?? source.totalCostUsd ?? source.cost_usd ?? source.costUsd);
  const modelUsage = isRecord(parsed.modelUsage) ? parsed.modelUsage : null;
  const modelUsageIds = modelUsage ? Object.keys(modelUsage) : [];
  const model = typeof parsed.model === 'string' && parsed.model.trim()
    ? parsed.model.trim()
    : typeof source.model === 'string' && source.model.trim()
      ? source.model.trim()
      : modelUsageIds.length === 1 ? modelUsageIds[0] : null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // A subscription-backed CLI and an API-backed CLI can run the same model.
    // Only accept the runtime's embedded charge instead of applying API prices
    // to an unknown billing mode.
    totalCostUsd: Number(embeddedCost.toFixed(6)),
    model,
  };
}

async function parseGrokCostFile(filePath: string): Promise<SessionCostData | null> {
  const exists = await access(filePath).then(() => true).catch(() => false);
  if (!exists) return null;
  const raw = await readFile(filePath, 'utf8');
  try {
    const whole = JSON.parse(raw) as unknown;
    if (isRecord(whole)) return extractUsage(whole);
  } catch {
    // Older Grok Build releases emitted one JSON object per line.
  }
  let last: SessionCostData | null = null;
  for (const line of raw.split('\n')) {
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

export async function parseGrokSessionCost(paths: string[]): Promise<SessionCostData> {
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
    const parsed = await parseGrokCostFile(filePath);
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
  runtimeId: 'grok',
  parseFiles: parseGrokSessionCost,
});
