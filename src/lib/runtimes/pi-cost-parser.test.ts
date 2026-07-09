import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePiSessionCost } from './pi-cost-parser';

describe('parsePiSessionCost', () => {
  it('reads get_session_stats response frames', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-cost-'));
    const file = path.join(dir, 'run.jsonl');
    await writeFile(file, [
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          tokens: {
            input: 12,
            output: 7,
            cacheRead: 3,
            cacheWrite: 2,
          },
          cost: 0.0042,
          model: 'anthropic/claude-sonnet-4-20250514',
        },
      }),
    ].join('\n'));

    await expect(parsePiSessionCost([file])).resolves.toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      totalCostUsd: 0.0042,
      model: 'anthropic/claude-sonnet-4-20250514',
    });
  });
});
