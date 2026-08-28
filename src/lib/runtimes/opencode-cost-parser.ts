/**
 * opencode cost parser + registration
 *
 * OpenCode 1 embeds cost in the final `result` JSONL event:
 *   {"type":"result","usage":{"inputTokens":N,"outputTokens":N,"totalCostUsd":X}}
 * OpenCode 2 emits one `step_finish` event per provider step:
 *   {"type":"step_finish","part":{"cost":X,"tokens":{"input":N,"output":N,"cache":{"read":N,"write":N}}}}
 *
 * When `totalCostUsd` is not present (e.g. offline models or older builds),
 * we fall back to the dated per-model rate table. We prefer returning 0
 * cost to throwing because the multi-provider surface cannot safely infer
 * an unknown model's rate.
 */

import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolveRate } from '@/lib/cost/rate-table';
import { registerCostParser } from '@/lib/runtimes/shared/cost-parser-registry';
import type { SessionCostData } from '@/lib/runtimes/shared/cost-parser-registry';

const TOKENS_PER_MILLION = 1_000_000;

function staticCost(inputTokens: number, outputTokens: number, model: string | null): { costUsd: number; priced: boolean } {
  const rate = resolveRate('opencode', model);
  if (!rate) return { costUsd: 0, priced: false };
  return {
    costUsd: (inputTokens * rate.inputUsdPerMillion + outputTokens * rate.outputUsdPerMillion) / TOKENS_PER_MILLION,
    priced: true,
  };
}

// ── JSONL parser ──────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return 0;
}

interface ParsedResultEvent {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;   // null means not embedded in the event
  model: string | null;
}

function extractResultEvent(line: Record<string, unknown>): ParsedResultEvent | null {
  if (line.type === 'step_finish') {
    const part = isRecord(line.part) ? line.part : null;
    const tokens = part && isRecord(part.tokens) ? part.tokens : null;
    const cache = tokens && isRecord(tokens.cache) ? tokens.cache : null;
    return {
      inputTokens: toNumber(tokens?.input),
      outputTokens: toNumber(tokens?.output),
      cacheReadTokens: toNumber(cache?.read),
      cacheWriteTokens: toNumber(cache?.write),
      costUsd: part?.cost != null ? toNumber(part.cost) : null,
      model: null,
    };
  }
  if (line.type !== 'result') return null;

  const usage = isRecord(line.usage) ? line.usage : null;
  const model = typeof line.model === 'string' && line.model.trim() ? line.model.trim() : null;

  // Try to get pre-computed cost first — opencode/openrouter often embeds it.
  const embeddedCost = usage?.totalCostUsd != null ? toNumber(usage.totalCostUsd) : null;
  const inputTokens = toNumber(usage?.inputTokens ?? usage?.input_tokens ?? 0);
  const outputTokens = toNumber(usage?.outputTokens ?? usage?.output_tokens ?? 0);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: toNumber(usage?.cacheReadTokens ?? usage?.cache_read_tokens ?? 0),
    cacheWriteTokens: toNumber(usage?.cacheWriteTokens ?? usage?.cache_write_tokens ?? 0),
    costUsd: embeddedCost,
    model,
  };
}

function extractModelFromInit(line: Record<string, unknown>): string | null {
  if (line.type !== 'init') return null;
  const model = readStr(line, 'model', 'modelId');
  return model ?? null;
}

function readStr(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

async function parseOpencodeJSONLFile(filePath: string): Promise<{
  results: ParsedResultEvent[];
  detectedModel: string | null;
}> {
  const exists = await access(filePath).then(() => true).catch(() => false);
  if (!exists) return { results: [], detectedModel: null };

  const lineReader = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const results: ParsedResultEvent[] = [];
  let detectedModel: string | null = null;

  for await (const rawLine of lineReader) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('{')) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Track model from init event
    const initModel = extractModelFromInit(parsed);
    if (initModel) {
      detectedModel = initModel;
    }

    // Also track model from message events if present
    if (!detectedModel) {
      const msgModel = readStr(parsed, 'model');
      if (msgModel) detectedModel = msgModel;
    }

    const resultEvent = extractResultEvent(parsed);
    if (resultEvent) {
      // Carry forward the detected model if the result event doesn't embed one
      if (!resultEvent.model && detectedModel) {
        resultEvent.model = detectedModel;
      }
      results.push(resultEvent);
    }
  }

  return { results, detectedModel };
}

// ── Public parser ─────────────────────────────────────────────────────────────

export async function parseOpencodeSessionCost(
  paths: string[],
  opts?: { fallbackModel?: string | null },
): Promise<SessionCostData> {
  const totals: SessionCostData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    model: null,
  };
  const models = new Set<string>();
  let fallbackModel = opts?.fallbackModel ?? null;
  let usedEstimate = false;
  let usedGateway = false;

  for (const filePath of paths) {
    const { results, detectedModel } = await parseOpencodeJSONLFile(filePath);
    if (detectedModel && !fallbackModel) {
      fallbackModel = detectedModel;
    }

    for (const r of results) {
      totals.inputTokens += r.inputTokens;
      totals.outputTokens += r.outputTokens;
      totals.cacheReadTokens += r.cacheReadTokens;
      totals.cacheWriteTokens += r.cacheWriteTokens;

      // Use embedded cost if available; otherwise resolve the dated table.
      if (r.costUsd !== null) {
        totals.totalCostUsd += r.costUsd;
        usedGateway = true;
      } else {
        const estimated = staticCost(r.inputTokens, r.outputTokens, r.model ?? fallbackModel);
        totals.totalCostUsd += estimated.costUsd;
        usedEstimate ||= estimated.priced;
      }

      if (r.model) models.add(r.model);
    }
  }

  totals.totalCostUsd = Number(totals.totalCostUsd.toFixed(6));
  totals.model = models.size === 1
    ? [...models][0]
    : models.size > 1
      ? 'mixed'
      : fallbackModel;
  totals.costSource = usedEstimate ? 'estimate' : usedGateway ? 'gateway' : 'unknown';

  return totals;
}

// ── Registration ──────────────────────────────────────────────────────────────

registerCostParser({
  runtimeId: 'opencode',
  parseFiles: parseOpencodeSessionCost,
});
