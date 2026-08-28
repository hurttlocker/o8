import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { resolveRate, type ResolvedRate } from '@/lib/cost/rate-table';
import type { SessionCostData } from '@/lib/runtimes/shared/cost-parser-registry';
import { registerCostParser } from '@/lib/runtimes/shared/cost-parser-registry';
export type { SessionCostData } from '@/lib/runtimes/shared/cost-parser-registry';

const TOKENS_PER_MILLION = 1_000_000;
const LONG_CONTEXT_THRESHOLD = 272_000;
const LONG_CONTEXT_INPUT_MULTIPLIER = 2;
const LONG_CONTEXT_OUTPUT_MULTIPLIER = 1.5;
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_CONFIG_PATH = path.join(CODEX_HOME, 'config.toml');

type CodexPricingModel = ResolvedRate & { longContextEligible: boolean };

type NormalizedUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type ParsedUsageEntry = {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  model: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function normalizeUsage(value: unknown): NormalizedUsage | null {
  if (!isRecord(value)) {
    return null;
  }

  const inputTokens = toTokenCount(value.input_tokens);
  const cachedInputTokens = Math.min(inputTokens, toTokenCount(value.cached_input_tokens));
  const outputTokens = toTokenCount(value.output_tokens);
  const totalTokens = toTokenCount(value.total_tokens);

  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
  };
}

function usageKey(usage: NormalizedUsage): string {
  return [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.totalTokens,
  ].join(':');
}

function diffUsage(next: NormalizedUsage, previous: NormalizedUsage | null): NormalizedUsage | null {
  if (!previous) {
    return next;
  }

  const delta = {
    inputTokens: Math.max(0, next.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, next.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
    totalTokens: Math.max(0, next.totalTokens - previous.totalTokens),
  };

  return delta.inputTokens > 0 || delta.cachedInputTokens > 0 || delta.outputTokens > 0 || delta.totalTokens > 0
    ? delta
    : null;
}

function detectPricingModel(rawModel: string | null | undefined): CodexPricingModel | null {
  const rate = resolveRate('codex', rawModel);
  if (!rate) return null;
  return {
    ...rate,
    longContextEligible: rate.modelKey === 'gpt-5.6-sol'
      || rate.modelKey === 'gpt-5.6-terra'
      || rate.modelKey === 'gpt-5.5'
      || rate.modelKey === 'gpt-5.4',
  };
}

function buildParsedUsageEntry(usage: NormalizedUsage, rawModel: string | null | undefined): ParsedUsageEntry {
  const pricing = detectPricingModel(rawModel);
  const model = pricing?.modelKey ?? rawModel?.trim() ?? null;
  const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const inputMultiplier = pricing?.longContextEligible && usage.inputTokens > LONG_CONTEXT_THRESHOLD
    ? LONG_CONTEXT_INPUT_MULTIPLIER
    : 1;
  const outputMultiplier = pricing?.longContextEligible && usage.inputTokens > LONG_CONTEXT_THRESHOLD
    ? LONG_CONTEXT_OUTPUT_MULTIPLIER
    : 1;
  const totalCostUsd = pricing
    ? (
      (uncachedInputTokens * pricing.inputUsdPerMillion * inputMultiplier)
      + (usage.cachedInputTokens * (pricing.cacheReadUsdPerMillion ?? 0) * inputMultiplier)
      + (usage.outputTokens * pricing.outputUsdPerMillion * outputMultiplier)
    ) / TOKENS_PER_MILLION
    : 0;

  return {
    inputTokens: uncachedInputTokens,
    cacheReadTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    totalCostUsd,
    model,
  };
}

function extractModel(line: Record<string, unknown>): string | null {
  const payload = isRecord(line.payload) ? line.payload : null;

  if (payload && typeof payload.model === 'string' && payload.model.trim()) {
    return payload.model.trim();
  }

  if (typeof line.model === 'string' && line.model.trim()) {
    return line.model.trim();
  }

  return null;
}

function extractTokenCountUsage(line: Record<string, unknown>, previousTotal: NormalizedUsage | null) {
  if (line.type !== 'event_msg') {
    return null;
  }

  const payload = isRecord(line.payload) ? line.payload : null;
  if (!payload || payload.type !== 'token_count') {
    return null;
  }

  const info = isRecord(payload.info) ? payload.info : null;
  if (!info) {
    return null;
  }

  const totalUsage = normalizeUsage(info.total_token_usage);
  const lastUsage = normalizeUsage(info.last_token_usage);
  if (!totalUsage && !lastUsage) {
    return null;
  }

  return {
    usage: lastUsage ?? (totalUsage ? diffUsage(totalUsage, previousTotal) : null),
    totalUsage: totalUsage ?? previousTotal,
  };
}

function extractTurnCompletedUsage(line: Record<string, unknown>): NormalizedUsage | null {
  if (line.type !== 'turn.completed') {
    return null;
  }

  return normalizeUsage(line.usage);
}

async function readConfiguredCodexModel(): Promise<string | null> {
  const raw = await readFile(CODEX_CONFIG_PATH, 'utf8').catch(() => null);
  if (!raw) {
    return null;
  }

  const match = raw.match(/^\s*model\s*=\s*"([^"]+)"/m);
  return match?.[1]?.trim() || null;
}

async function parseCodexUsageFile(filePath: string, fallbackModel: string | null): Promise<ParsedUsageEntry[]> {
  const exists = await access(filePath).then(() => true).catch(() => false);
  if (!exists) {
    return [];
  }

  const lineReader = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let currentModel = fallbackModel;
  let previousTotal: NormalizedUsage | null = null;
  const tokenCountEntries: ParsedUsageEntry[] = [];
  const turnCompletedEntries: ParsedUsageEntry[] = [];
  const seenSnapshots = new Set<string>();

  for await (const line of lineReader) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsedLine: Record<string, unknown>;
    try {
      parsedLine = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    currentModel = extractModel(parsedLine) ?? currentModel;

    const tokenCount = extractTokenCountUsage(parsedLine, previousTotal);
    if (tokenCount) {
      const snapshot = tokenCount.totalUsage;
      if (snapshot) {
        const snapshotKey = usageKey(snapshot);
        if (!seenSnapshots.has(snapshotKey)) {
          seenSnapshots.add(snapshotKey);
          if (tokenCount.usage) {
            tokenCountEntries.push(buildParsedUsageEntry(tokenCount.usage, currentModel));
          }
        }
        previousTotal = snapshot;
      }
      continue;
    }

    const turnCompletedUsage = extractTurnCompletedUsage(parsedLine);
    if (turnCompletedUsage) {
      turnCompletedEntries.push(buildParsedUsageEntry(turnCompletedUsage, currentModel));
    }
  }

  return tokenCountEntries.length > 0 ? tokenCountEntries : turnCompletedEntries;
}

export async function parseCodexSessionCost(
  sessionPaths: string | string[],
  explicitFallbackModel?: string | null,
): Promise<SessionCostData> {
  const paths = Array.isArray(sessionPaths) ? sessionPaths : [sessionPaths];
  const fallbackModel = explicitFallbackModel ?? await readConfiguredCodexModel();
  const totals: SessionCostData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    model: null,
  };
  const models = new Set<string>();

  for (const sessionPath of paths) {
    const entries = await parseCodexUsageFile(sessionPath, fallbackModel);
    for (const entry of entries) {
      totals.inputTokens += entry.inputTokens;
      totals.outputTokens += entry.outputTokens;
      totals.cacheReadTokens += entry.cacheReadTokens;
      totals.totalCostUsd += entry.totalCostUsd;
      if (entry.model) {
        models.add(entry.model);
      }
    }
  }

  totals.totalCostUsd = Number(totals.totalCostUsd.toFixed(6));
  totals.model = models.size === 1 ? [...models][0] : models.size > 1 ? 'mixed' : fallbackModel;
  if (totals.totalCostUsd > 0) totals.costSource = 'estimate';

  return totals;
}

// ── Self-registration ─────────────────────────────────────────────────────────
// Runs on import so the registry is populated before any caller invokes parseCost.
registerCostParser({
  runtimeId: 'codex',
  parseFiles: (paths, opts) => parseCodexSessionCost(paths, opts?.fallbackModel),
});
