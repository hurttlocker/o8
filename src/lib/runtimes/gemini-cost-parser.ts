/**
 * Gemini session cost parser.
 *
 * Reads stdout JSONL emitted by the headless `gemini -p "<task>" --output-format
 * stream-json` invocation, then totals token usage from the final `result`
 * event. When the stream doesn't carry a `stats` block (older CLI versions or
 * interrupted runs), we fall back to Gemini's persisted session file at
 * `~/.gemini/tmp/<projectHash>/chats/<uuid>.json` which keeps a full usage
 * breakdown.
 *
 * Registers itself against the cost-parser-registry under runtimeId='gemini'
 * on module load — adapters call `parseCost('gemini', stdoutPaths)`.
 */

import { createReadStream } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { resolveRate, type ResolvedRate } from '@/lib/cost/rate-table';
import type { SessionCostData } from '@/lib/runtimes/shared/cost-parser-registry';
import { registerCostParser } from '@/lib/runtimes/shared/cost-parser-registry';
export type { SessionCostData } from '@/lib/runtimes/shared/cost-parser-registry';

const TOKENS_PER_MILLION = 1_000_000;

// Fallback when the stream mentions a model we don't have pricing for — treat
// it as Gemini 3 Pro. Pessimistic direction: slightly overestimates for flash
// models, but only fires when model name is unknown, which should be rare.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function detectPricing(rawModel: string | null | undefined): ResolvedRate {
  return resolveRate('gemini', rawModel)!;
}

interface AccumulatedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  model: string | null;
}

function extractUsageFromStats(stats: Record<string, unknown>): AccumulatedUsage | null {
  const inputTokens = toTokenCount(stats.input_tokens ?? stats.inputTokens ?? stats.promptTokenCount);
  const outputTokens = toTokenCount(stats.output_tokens ?? stats.outputTokens ?? stats.candidatesTokenCount);
  const cacheReadTokens = toTokenCount(
    stats.cached_input_tokens
      ?? stats.cachedInputTokens
      ?? stats.cachedContentTokenCount
      ?? stats.cache_read_tokens
      ?? stats.cacheReadTokens,
  );
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0) {
    return null;
  }
  const model = typeof stats.model === 'string' ? stats.model : null;
  return { inputTokens, outputTokens, cacheReadTokens, model };
}

// ── Stdout JSONL parser ──────────────────────────────────────────────────────

async function parseGeminiStdoutFile(filePath: string): Promise<AccumulatedUsage | null> {
  const exists = await access(filePath).then(() => true).catch(() => false);
  if (!exists) return null;

  const lineReader = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let detectedModel: string | null = null;
  let fromResult: AccumulatedUsage | null = null;

  for await (const line of lineReader) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof parsed.model === 'string' && parsed.model.trim()) {
      detectedModel = parsed.model.trim();
    }

    const type = String(parsed.type ?? '').toLowerCase();
    if (type !== 'result') continue;

    const stats = isRecord(parsed.stats)
      ? parsed.stats
      : isRecord(parsed.usage)
        ? parsed.usage
        : null;
    if (!stats) continue;

    const usage = extractUsageFromStats(stats);
    if (usage) {
      fromResult = {
        ...usage,
        model: usage.model ?? detectedModel,
      };
    }
  }

  return fromResult;
}

// ── Session-file fallback ────────────────────────────────────────────────────
//
// Gemini persists the full chat + usageMetadata to
// `~/.gemini/tmp/<projectHash>/chats/<uuid>.json`. When the stdout path
// doesn't include token stats (older CLI, or interrupted runs), scan the
// newest session file newer than our stdout and pull usageMetadata out of it.

const GEMINI_SESSION_ROOT = path.join(
  process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini'),
  'tmp',
);

async function findLatestSessionFile(): Promise<string | null> {
  const exists = await access(GEMINI_SESSION_ROOT).then(() => true).catch(() => false);
  if (!exists) return null;

  let newest: { path: string; mtimeMs: number } | null = null;
  const projectDirs = await readdir(GEMINI_SESSION_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const chatDir = path.join(GEMINI_SESSION_ROOT, entry.name, 'chats');
    const chatEntries = await readdir(chatDir, { withFileTypes: true }).catch(() => []);
    for (const chat of chatEntries) {
      if (!chat.isFile() || !chat.name.endsWith('.json')) continue;
      const p = path.join(chatDir, chat.name);
      const info = await stat(p).catch(() => null);
      if (!info) continue;
      if (!newest || info.mtimeMs > newest.mtimeMs) {
        newest = { path: p, mtimeMs: info.mtimeMs };
      }
    }
  }
  return newest?.path ?? null;
}

async function parseGeminiSessionFile(filePath: string): Promise<AccumulatedUsage | null> {
  const exists = await access(filePath).then(() => true).catch(() => false);
  if (!exists) return null;

  const raw = await readFile(filePath, 'utf8').catch(() => null);
  if (!raw) return null;

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }

  const record = isRecord(doc) ? doc : null;
  if (!record) return null;

  // Known shapes: { usageMetadata: { ... } } at top level or under .metadata,
  // plus a per-message usage array in some CLI builds. We accept either.
  const aggregate: AccumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, model: null };

  const tryAddFromStats = (stats: unknown) => {
    if (!isRecord(stats)) return;
    const usage = extractUsageFromStats(stats);
    if (!usage) return;
    aggregate.inputTokens += usage.inputTokens;
    aggregate.outputTokens += usage.outputTokens;
    aggregate.cacheReadTokens += usage.cacheReadTokens;
    aggregate.model = aggregate.model ?? usage.model;
  };

  tryAddFromStats(record.usageMetadata);
  if (isRecord(record.metadata)) {
    tryAddFromStats(record.metadata.usageMetadata);
  }
  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      if (!isRecord(message)) continue;
      tryAddFromStats(message.usageMetadata);
      tryAddFromStats(message.usage);
    }
  }

  const detectedModel = typeof record.model === 'string' ? record.model : null;
  aggregate.model = aggregate.model ?? detectedModel;

  if (aggregate.inputTokens === 0 && aggregate.outputTokens === 0 && aggregate.cacheReadTokens === 0) {
    return null;
  }
  return aggregate;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function parseGeminiSessionCost(
  sessionPaths: string | string[],
  explicitFallbackModel?: string | null,
): Promise<SessionCostData> {
  const paths = Array.isArray(sessionPaths) ? sessionPaths : [sessionPaths];
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
    const usage = await parseGeminiStdoutFile(sessionPath);
    if (!usage) continue;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    if (usage.model) models.add(usage.model);
  }

  // Fallback: scan the newest persisted Gemini session file if the stdout had
  // no stats. Only triggers when stdout totals are empty to avoid
  // double-counting.
  if (totals.inputTokens === 0 && totals.outputTokens === 0 && totals.cacheReadTokens === 0) {
    const sessionFile = await findLatestSessionFile();
    if (sessionFile) {
      const usage = await parseGeminiSessionFile(sessionFile);
      if (usage) {
        totals.inputTokens += usage.inputTokens;
        totals.outputTokens += usage.outputTokens;
        totals.cacheReadTokens += usage.cacheReadTokens;
        if (usage.model) models.add(usage.model);
      }
    }
  }

  const resolvedModel = models.size === 1
    ? [...models][0]
    : models.size > 1
      ? 'mixed'
      : explicitFallbackModel ?? null;

  const pricing = detectPricing(resolvedModel);
  const uncachedInput = Math.max(0, totals.inputTokens - totals.cacheReadTokens);
  totals.totalCostUsd = Number(
    (
      (uncachedInput * pricing.inputUsdPerMillion)
      + (totals.cacheReadTokens * (pricing.cacheReadUsdPerMillion ?? 0))
      + (totals.outputTokens * pricing.outputUsdPerMillion)
    ) / TOKENS_PER_MILLION,
  );
  totals.totalCostUsd = Number(totals.totalCostUsd.toFixed(6));
  totals.model = resolvedModel ?? pricing.modelKey;
  if (totals.totalCostUsd > 0) totals.costSource = 'estimate';

  return totals;
}

// ── Self-registration ────────────────────────────────────────────────────────

registerCostParser({
  runtimeId: 'gemini',
  parseFiles: (paths, opts) => parseGeminiSessionCost(paths, opts?.fallbackModel),
});
