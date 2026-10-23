import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import './cost-parser';
import { parseCost } from './shared/cost-parser-registry';
import type { RuntimeTelemetry } from './types';

export async function readClaudeRuntimeTelemetry(jsonlPath: string): Promise<RuntimeTelemetry | undefined> {
  return readClaudeRuntimeTelemetryFromPaths([jsonlPath]);
}

export async function readClaudeRuntimeTelemetryFromPaths(jsonlPaths: string[]): Promise<RuntimeTelemetry | undefined> {
  const sessionCost = await parseCost('claude-code', jsonlPaths);
  if (!sessionCost) return undefined;

  // Costs include native children. Only the latest parent request measures
  // context; both earlier parent requests and child internals stay in billing.
  let context: RuntimeTelemetry = {};
  const lines = createInterface({ input: createReadStream(jsonlPaths.at(-1)!, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant') continue;
        context = {};
        const usage = entry.message?.usage;
        if (!usage) continue;
        const cacheWrite = usage.cache_creation_input_tokens
          ?? (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
        const parts = [usage.input_tokens ?? 0, usage.cache_read_input_tokens ?? 0, cacheWrite];
        if (!parts.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) continue;
        const tokens = parts.reduce((sum, value) => sum + value, 0);
        if (tokens > 0) context = { contextTokens: tokens, contextSource: 'claude-last-request-input' };
      } catch { /* Incomplete JSONL tail. */ }
    }
  } catch { /* No context measurement; callers can estimate the transcript. */ }
  return {
    totalTokens: sessionCost.inputTokens
      + sessionCost.outputTokens
      + sessionCost.cacheReadTokens
      + sessionCost.cacheWriteTokens,
    ...context,
    estimatedCostUsd: sessionCost.totalCostUsd,
    costSource: 'estimate',
    inputTokens: sessionCost.inputTokens,
    outputTokens: sessionCost.outputTokens,
    cacheReadTokens: sessionCost.cacheReadTokens,
    cacheWriteTokens: sessionCost.cacheWriteTokens,
    model: sessionCost.model ?? undefined,
  };
}
