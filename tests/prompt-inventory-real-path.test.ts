import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('offline prompt inventory entry point', () => {
  it('includes production native prompts after test declarations and continued strings', () => {
    const rows = JSON.parse(execFileSync(process.execPath, ['scripts/prompt-audit.mjs', '--json'], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    })) as Array<{ file: string; name: string; after: number }>;
    for (const name of ['screen_prompt_section', 'edit_prompt_section', 'spatial_prompt_section']) {
      expect(rows.find((row) => row.file === 'src-tauri/src/agent/mod.rs' && row.name === name)?.after, name).toBeGreaterThan(0);
    }
    expect(rows.find((row) => row.file === 'src-tauri/src/ai/gemini_ask.rs' && row.name === 'ASK_SYSTEM_PROMPT')?.after).toBeGreaterThan(100);
    expect(rows.filter((row) => row.file === 'src-tauri/src/agent/tools/mod.rs' && row.name.startsWith('native-tool-description-')).length).toBeGreaterThan(20);
    for (const name of ['catalog_block', 'escalate_block', 'tool_lookup_message', 'lookup_budget_spent_message', 'NEXT_ACTION_TAIL']) {
      expect(rows.find((row) => row.file === 'src-tauri/src/agent/claude/planner_payload.rs' && row.name === name)?.after, name).toBeGreaterThan(0);
    }
    expect(rows.find((row) => row.file === 'src-tauri/src/agent/claude.rs' && row.name === 'PLANNER_CONTRACT')?.after).toBeGreaterThan(100);
    expect(rows.some((row) => row.name.startsWith('test_'))).toBe(false);
  });
});
