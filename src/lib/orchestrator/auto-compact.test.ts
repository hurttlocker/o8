import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const testRoot = mkdtempSync(join(os.tmpdir(), 'o8-auto-compact-cost-'));
const dataDir = join(testRoot, 'data');
const repoPath = join(testRoot, 'repo');
const fakeCodex = join(testRoot, 'fake-codex.mjs');
const threadId = 'thoughts-auto-compact-cost';

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CODEX_BIN = fakeCodex;
mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
mkdirSync(repoPath, { recursive: true });
writeFileSync(fakeCodex, [
  '#!/usr/bin/env node',
  "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 321, output_tokens: 45 } }));",
  "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Decisions made\\n- Keep the ledger complete.\\nFiles touched\\n- None.\\nOpen questions\\n- None.\\nCurrent mission state\\n- Continue.' } }));",
].join('\n'));
chmodSync(fakeCodex, 0o755);
writeFileSync(join(dataDir, 'chat-history', `${threadId}.json`), JSON.stringify({
  repoPath,
  messages: Array.from({ length: 6 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${index}`,
    timestamp: index + 1,
  })),
}));

const { getSqlite } = await import('@/lib/db');
const { autoCompactOrchestratorThread } = await import('./auto-compact');

afterAll(() => {
  delete process.env.O8_CODEX_BIN;
  rmSync(testRoot, { recursive: true, force: true });
});

describe('auto compaction cost ledger', () => {
  it('writes one compaction-role usage row from Codex telemetry', async () => {
    const result = await autoCompactOrchestratorThread({
      repoPath,
      threadId,
      keepTailCount: 2,
      trigger: 'manual',
      force: true,
    });
    expect(result.applied).toBe(true);

    const rows = getSqlite().prepare(`
      SELECT role, input_tokens, output_tokens, cost_usd, metadata_json
      FROM usage_logs WHERE role = 'compaction'
    `).all() as Array<{
      role: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      metadata_json: string;
    }>;
    expect(rows).toEqual([expect.objectContaining({
      role: 'compaction',
      input_tokens: 321,
      output_tokens: 45,
      cost_usd: 0,
    })]);
    expect(JSON.parse(rows[0]!.metadata_json)).toEqual({
      estimated: false,
      source: 'codex_turn_completed',
    });
  });
});
