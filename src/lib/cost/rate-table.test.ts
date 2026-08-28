import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { estimateCostUsd } from '@/lib/cortex/qa/llm/brain-spend';
import { parseCodexSessionCost } from '@/lib/runtimes/codex-cost-parser';
import { parseSessionCost } from '@/lib/runtimes/cost-parser';
import { parseCursorSessionCost } from '@/lib/runtimes/cursor-cost-parser';
import { parseGeminiSessionCost } from '@/lib/runtimes/gemini-cost-parser';
import { parseOpencodeSessionCost } from '@/lib/runtimes/opencode-cost-parser';
import { modelRateTable, resolveRate } from './rate-table';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'o8-rate-table-'));
const TOKENS_PER_MILLION = 1_000_000;

function fixture(name: string, row: Record<string, unknown>): string {
  const filePath = join(fixtureRoot, name);
  writeFileSync(filePath, `${JSON.stringify(row)}\n`);
  return filePath;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() ? [path] : [];
  });
}

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('dated model rate table reproducibility', () => {
  it('reproduces each table-priced parser and the Brain estimator', async () => {
    const claudeRate = resolveRate('claude-code', 'claude-sonnet-5')!;
    const claude = await parseSessionCost(fixture('claude.jsonl', {
      type: 'assistant',
      requestId: 'claude-rate-fixture',
      message: {
        id: 'claude-rate-fixture',
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: 100_000,
          output_tokens: 20_000,
          cache_read_input_tokens: 10_000,
          cache_creation_input_tokens: 6_000,
          cache_creation: {
            ephemeral_5m_input_tokens: 4_000,
            ephemeral_1h_input_tokens: 2_000,
          },
        },
      },
    }));
    expect(claude.totalCostUsd).toBe(rounded((
      100_000 * claudeRate.inputUsdPerMillion
      + 20_000 * claudeRate.outputUsdPerMillion
      + 10_000 * claudeRate.cacheReadUsdPerMillion!
      + 4_000 * claudeRate.cacheWriteUsdPerMillion!
      + 2_000 * claudeRate.cacheWrite1hUsdPerMillion!
    ) / TOKENS_PER_MILLION));

    const codexRate = resolveRate('codex', 'gpt-5.5')!;
    const codex = await parseCodexSessionCost(fixture('codex.jsonl', {
      type: 'turn.completed',
      model: 'gpt-5.5',
      usage: {
        input_tokens: 100_000,
        cached_input_tokens: 20_000,
        output_tokens: 10_000,
        total_tokens: 110_000,
      },
    }), 'gpt-5.5');
    expect(codex.totalCostUsd).toBe(rounded((
      80_000 * codexRate.inputUsdPerMillion
      + 20_000 * codexRate.cacheReadUsdPerMillion!
      + 10_000 * codexRate.outputUsdPerMillion
    ) / TOKENS_PER_MILLION));

    const geminiRate = resolveRate('gemini', 'gemini-2.5-flash')!;
    const gemini = await parseGeminiSessionCost(fixture('gemini.jsonl', {
      type: 'result',
      model: 'gemini-2.5-flash',
      stats: { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: 20_000 },
    }));
    expect(gemini.totalCostUsd).toBe(rounded((
      80_000 * geminiRate.inputUsdPerMillion
      + 20_000 * geminiRate.cacheReadUsdPerMillion!
      + 10_000 * geminiRate.outputUsdPerMillion
    ) / TOKENS_PER_MILLION));

    const cursorRate = resolveRate('cursor', 'cursor-fast')!;
    const cursor = await parseCursorSessionCost([fixture('cursor.jsonl', {
      type: 'result',
      model: 'cursor-fast',
      usage: { inputTokens: 100_000, outputTokens: 10_000, cacheWriteTokens: 5_000 },
    })]);
    expect(cursor.totalCostUsd).toBe(rounded((
      100_000 * cursorRate.inputUsdPerMillion
      + 10_000 * cursorRate.outputUsdPerMillion
      + 5_000 * cursorRate.cacheWriteUsdPerMillion!
    ) / TOKENS_PER_MILLION));

    const opencodeRate = resolveRate('opencode', 'opencode/gpt-5-nano')!;
    const opencode = await parseOpencodeSessionCost([fixture('opencode.jsonl', {
      type: 'result',
      model: 'opencode/gpt-5-nano',
      usage: { inputTokens: 100_000, outputTokens: 10_000 },
    })]);
    expect(opencode.totalCostUsd).toBe(rounded((
      100_000 * opencodeRate.inputUsdPerMillion
      + 10_000 * opencodeRate.outputUsdPerMillion
    ) / TOKENS_PER_MILLION));

    const brainRate = resolveRate('brain', 'google/gemini-2.5-flash-lite')!;
    expect(estimateCostUsd('google/gemini-2.5-flash-lite', {
      prompt_tokens: 100_000,
      completion_tokens: 10_000,
    })).toBe((
      100_000 * brainRate.inputUsdPerMillion
      + 10_000 * brainRate.outputUsdPerMillion
    ) / TOKENS_PER_MILLION);

    expect(modelRateTable).toMatchObject({
      rateTableVersion: '2026-08-28.1',
      observedOn: '2026-08-28',
    });
  });

  it('keeps private price-literal markers out of runtime and Brain sources', () => {
    const roots = [
      join(process.cwd(), 'src/lib/runtimes'),
      join(process.cwd(), 'src/lib/cortex'),
    ];
    const forbidden = /USD_PER_MILLION|per 1M|USD per token/;
    const matches = roots.flatMap(sourceFiles).flatMap((filePath) => {
      const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
      return lines.flatMap((line, index) => forbidden.test(line)
        ? [`${filePath.slice(process.cwd().length + 1)}:${index + 1}:${line.trim()}`]
        : []);
    });
    expect(matches).toEqual([]);
  });
});
