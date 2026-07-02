import { describe, it, expect } from 'vitest';
import { BRAIN_READ_ONLY_TOOLS } from '@/lib/llm/brain-tools';

// The Brain composer ("Ask the Brain") gates tool execution on this allowlist and
// DECLINES anything not on it — no mutating/shell tool runs ungated (§HIGH-7).
describe('scratch-chat read-only tool allowlist', () => {
  it('excludes every mutating / shell / dispatch tool', () => {
    for (const t of [
      'run_terminal_command', 'write_file', 'edit_file', 'delete_file',
      'create_github_issue', 'create_pull_request', 'dispatch_codex_task', 'lane_command',
    ]) {
      expect(BRAIN_READ_ONLY_TOOLS.has(t), t).toBe(false);
    }
  });

  it('includes the read-only repo-exploration tools', () => {
    for (const t of ['read_file', 'search_code', 'list_files', 'read_github_issue_or_pr', 'list_lanes']) {
      expect(BRAIN_READ_ONLY_TOOLS.has(t), t).toBe(true);
    }
  });
});
