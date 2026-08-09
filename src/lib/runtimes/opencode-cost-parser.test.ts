import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseOpencodeSessionCost } from './opencode-cost-parser';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('OpenCode 2 cost parser', () => {
  it('sums every V2 provider step including cache tokens and embedded cost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'o8-opencode2-cost-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'run.jsonl');
    writeFileSync(logPath, [
      JSON.stringify({ type: 'step_start', sessionID: 'ses_test' }),
      JSON.stringify({
        type: 'step_finish',
        part: {
          cost: 0.0012,
          tokens: { input: 100, output: 20, cache: { read: 30, write: 4 } },
        },
      }),
      JSON.stringify({ type: 'tool_use', part: { tool: 'bash' } }),
      JSON.stringify({
        type: 'step_finish',
        part: {
          cost: 0.0023,
          tokens: { input: 250, output: 40, cache: { read: 50, write: 6 } },
        },
      }),
    ].join('\n'));

    await expect(parseOpencodeSessionCost([logPath], {
      fallbackModel: 'opencode/deepseek-v4-flash-free',
    })).resolves.toEqual({
      inputTokens: 350,
      outputTokens: 60,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      totalCostUsd: 0.0035,
      model: 'opencode/deepseek-v4-flash-free',
    });
  });

  it('keeps parsing archived OpenCode 1 result events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'o8-opencode1-cost-'));
    tempDirs.push(dir);
    const logPath = join(dir, 'run.jsonl');
    writeFileSync(logPath, JSON.stringify({
      type: 'result',
      model: 'opencode/gpt-5-nano',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        totalCostUsd: 0.00001,
      },
    }));

    await expect(parseOpencodeSessionCost([logPath])).resolves.toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalCostUsd: 0.00001,
      model: 'opencode/gpt-5-nano',
    });
  });
});
