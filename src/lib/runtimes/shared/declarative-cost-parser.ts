import { readFile } from 'node:fs/promises';

import {
  registerCostParser,
  type SessionCostData,
} from './cost-parser-registry';

export type DeclarativeCostFormat = 'structured' | 'text';

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function findTokenCount(value: unknown, keys: string[]): number {
  if (Array.isArray(value)) {
    return value.reduce((highest, entry) => Math.max(highest, findTokenCount(entry, keys)), 0);
  }
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  let highest = 0;
  for (const key of keys) highest = Math.max(highest, tokenCount(record[key]));
  for (const child of Object.values(record)) highest = Math.max(highest, findTokenCount(child, keys));
  return highest;
}

function structuredCost(lines: string[], fallbackModel: string | null): SessionCostData {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      inputTokens = Math.max(inputTokens, findTokenCount(parsed, [
        'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokenCount',
      ]));
      outputTokens = Math.max(outputTokens, findTokenCount(parsed, [
        'output_tokens', 'outputTokens', 'completion_tokens', 'candidatesTokenCount',
      ]));
      cacheReadTokens = Math.max(cacheReadTokens, findTokenCount(parsed, [
        'cached_input_tokens', 'cacheReadTokens', 'cachedContentTokenCount',
      ]));
    } catch {
      // Unknown NDJSON rows are ignored; adapter parsing remains best-effort.
    }
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    model: fallbackModel,
  };
}

function textCost(lines: string[], fallbackModel: string | null): SessionCostData {
  const raw = lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
  const explicitInput = [...raw.matchAll(/(?:input|prompt)\s*tokens?\D+(\d[\d,]*)/gi)]
    .reduce((highest, match) => Math.max(highest, Number(match[1]?.replaceAll(',', '') ?? 0)), 0);
  const explicitOutput = [...raw.matchAll(/(?:output|completion)\s*tokens?\D+(\d[\d,]*)/gi)]
    .reduce((highest, match) => Math.max(highest, Number(match[1]?.replaceAll(',', '') ?? 0)), 0);
  return {
    inputTokens: explicitInput,
    outputTokens: explicitOutput || Math.ceil(raw.trim().length / 4),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    model: fallbackModel,
  };
}

export function registerDeclarativeCostParser(
  runtimeId: string,
  format: DeclarativeCostFormat,
): void {
  const parseLines = async (
    lines: string[],
    opts?: { fallbackModel?: string | null },
  ) => format === 'structured'
    ? structuredCost(lines, opts?.fallbackModel ?? null)
    : textCost(lines, opts?.fallbackModel ?? null);

  registerCostParser({
    runtimeId,
    parseLines,
    async parseFiles(paths, opts) {
      const contents = await Promise.all(paths.map((filePath) => readFile(filePath, 'utf8').catch(() => '')));
      return parseLines(contents.flatMap((content) => content.split(/\r?\n/)), opts);
    },
  });
}
