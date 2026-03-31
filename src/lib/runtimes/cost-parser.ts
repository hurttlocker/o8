import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

const TOKENS_PER_MILLION = 1_000_000;
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

interface ClaudeUsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  service_tier?: string | null;
  speed?: string | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface ClaudeJsonlEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: ClaudeUsagePayload;
  };
}

interface PricingModel {
  canonicalModel: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

interface ParsedUsageEntry {
  cacheReadTokens: number;
  cacheWrite1hTokens: number;
  cacheWrite5mTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  model: string | null;
  outputTokens: number;
  totalCostUsd: number;
}

export interface SessionCostData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
  model: string | null;
}

function toTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function detectPricingModel(rawModel: string | null | undefined, usage: ClaudeUsagePayload): PricingModel | null {
  const normalizedModel = rawModel?.trim().toLowerCase();
  if (!normalizedModel || normalizedModel === '<synthetic>') {
    return null;
  }

  const normalizedTier = usage.service_tier?.trim().toLowerCase();
  const normalizedSpeed = usage.speed?.trim().toLowerCase();
  const isFastTier = normalizedTier === 'fast'
    || normalizedTier === 'priority'
    || normalizedSpeed === 'fast'
    || normalizedModel.includes('fast');

  if (normalizedModel.includes('opus-4-6')) {
    return {
      canonicalModel: isFastTier ? 'claude-opus-4-6-fast' : 'claude-opus-4-6',
      inputUsdPerMillion: isFastTier ? 30 : 5,
      outputUsdPerMillion: isFastTier ? 150 : 25,
    };
  }

  if (normalizedModel.includes('sonnet-4-6')) {
    return {
      canonicalModel: 'claude-sonnet-4-6',
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    };
  }

  if (normalizedModel.includes('sonnet-4-5') || normalizedModel.includes('sonnet-4')) {
    return {
      canonicalModel: 'claude-sonnet-4-5',
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    };
  }

  if (normalizedModel.includes('haiku-4-5') || normalizedModel.includes('haiku')) {
    return {
      canonicalModel: 'claude-haiku-4-5',
      inputUsdPerMillion: 0.8,
      outputUsdPerMillion: 4,
    };
  }

  return null;
}

function buildParsedUsageEntry(
  usage: ClaudeUsagePayload,
  rawModel: string | null | undefined,
  fallbackModel: string | null,
): ParsedUsageEntry {
  const inputTokens = toTokenCount(usage.input_tokens);
  const outputTokens = toTokenCount(usage.output_tokens);
  const cacheReadTokens = toTokenCount(usage.cache_read_input_tokens);
  const cacheWrite5mTokens = toTokenCount(usage.cache_creation?.ephemeral_5m_input_tokens);
  const cacheWrite1hTokens = toTokenCount(usage.cache_creation?.ephemeral_1h_input_tokens);
  const cacheWriteTokens = Math.max(
    toTokenCount(usage.cache_creation_input_tokens),
    cacheWrite5mTokens + cacheWrite1hTokens,
  );
  const cacheWriteRemainder = Math.max(0, cacheWriteTokens - cacheWrite5mTokens - cacheWrite1hTokens);
  const normalizedCacheWrite5mTokens = cacheWrite5mTokens + cacheWriteRemainder;
  const pricing = detectPricingModel(rawModel, usage);
  const model = pricing?.canonicalModel ?? fallbackModel ?? rawModel?.trim() ?? null;
  const inputRate = pricing?.inputUsdPerMillion ?? 0;
  const outputRate = pricing?.outputUsdPerMillion ?? 0;

  const totalCostUsd = (
    (inputTokens * inputRate)
    + (outputTokens * outputRate)
    + (cacheReadTokens * inputRate * CACHE_READ_MULTIPLIER)
    + (normalizedCacheWrite5mTokens * inputRate * CACHE_WRITE_5M_MULTIPLIER)
    + (cacheWrite1hTokens * inputRate * CACHE_WRITE_1H_MULTIPLIER)
  ) / TOKENS_PER_MILLION;

  return {
    cacheReadTokens,
    cacheWrite1hTokens,
    cacheWrite5mTokens: normalizedCacheWrite5mTokens,
    cacheWriteTokens,
    inputTokens,
    model,
    outputTokens,
    totalCostUsd,
  };
}

async function resolveSessionFiles(sessionDir: string): Promise<string[]> {
  const sessionPath = path.resolve(sessionDir);
  const stats = await stat(sessionPath).catch(() => null);
  if (!stats) {
    return [];
  }

  if (stats.isFile()) {
    return path.extname(sessionPath) === '.jsonl' ? [sessionPath] : [];
  }

  if (!stats.isDirectory()) {
    return [];
  }

  const entries = await readdir(sessionPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(sessionPath, entry.name))
    .sort();
}

export async function parseSessionCost(sessionDir: string): Promise<SessionCostData> {
  const sessionFiles = await resolveSessionFiles(sessionDir);
  const dedupedUsage = new Map<string, ParsedUsageEntry>();
  let fallbackModel: string | null = null;

  for (const sessionFile of sessionFiles) {
    const lineReader = createInterface({
      input: createReadStream(sessionFile, { encoding: 'utf8' }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    let lineNumber = 0;
    for await (const line of lineReader) {
      lineNumber += 1;
      if (!line.trim()) continue;

      let entry: ClaudeJsonlEntry;
      try {
        entry = JSON.parse(line) as ClaudeJsonlEntry;
      } catch {
        continue;
      }

      if (entry.type !== 'assistant' || !entry.message?.usage) {
        continue;
      }

      const parsedUsage = buildParsedUsageEntry(entry.message.usage, entry.message.model, fallbackModel);
      const totalTokens = parsedUsage.inputTokens
        + parsedUsage.outputTokens
        + parsedUsage.cacheReadTokens
        + parsedUsage.cacheWriteTokens;
      if (parsedUsage.model && parsedUsage.model !== '<synthetic>') {
        fallbackModel = parsedUsage.model;
      }
      if (totalTokens === 0) {
        continue;
      }

      const dedupeKey = entry.requestId
        ?? entry.message.id
        ?? entry.uuid
        ?? `${sessionFile}:${entry.timestamp ?? lineNumber}`;
      const existing = dedupedUsage.get(dedupeKey);
      if (!existing) {
        dedupedUsage.set(dedupeKey, parsedUsage);
        continue;
      }

      dedupedUsage.set(dedupeKey, {
        cacheReadTokens: Math.max(existing.cacheReadTokens, parsedUsage.cacheReadTokens),
        cacheWrite1hTokens: Math.max(existing.cacheWrite1hTokens, parsedUsage.cacheWrite1hTokens),
        cacheWrite5mTokens: Math.max(existing.cacheWrite5mTokens, parsedUsage.cacheWrite5mTokens),
        cacheWriteTokens: Math.max(existing.cacheWriteTokens, parsedUsage.cacheWriteTokens),
        inputTokens: Math.max(existing.inputTokens, parsedUsage.inputTokens),
        model: parsedUsage.model ?? existing.model,
        outputTokens: Math.max(existing.outputTokens, parsedUsage.outputTokens),
        totalCostUsd: Math.max(existing.totalCostUsd, parsedUsage.totalCostUsd),
      });
    }
  }

  const totals: SessionCostData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    model: null,
  };
  const models = new Set<string>();

  for (const usage of dedupedUsage.values()) {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    totals.totalCostUsd += usage.totalCostUsd;
    if (usage.model) {
      models.add(usage.model);
    }
  }

  totals.totalCostUsd = Number(totals.totalCostUsd.toFixed(6));
  totals.model = models.size === 1 ? [...models][0] : models.size > 1 ? 'mixed' : fallbackModel;

  return totals;
}
