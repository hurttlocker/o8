import { describe, expect, it } from 'vitest';
import type { CodexThreadRow } from './discovery-store';
import { buildCodexActivityMap, type LiveCodexProcess } from './live-process-discovery';

const threadId = '01a0d4e6-42a3-7771-a56e-46d16a2868bd';
const thread: CodexThreadRow = {
  id: threadId,
  title: 'Read-only local turn',
  cwd: '/repo',
  updated_at: 1790278286,
  rollout_path: `/home/user/.codex/sessions/rollout-${threadId}.jsonl`,
};
const process: LiveCodexProcess = {
  pid: 90403,
  tty: 's000',
  command: '/bin/codex -m gpt-5.6-terra',
};

describe('Codex live thread identity', () => {
  it('recovers the exact live thread from its open writer lock without the old logs table', async () => {
    const activity = await buildCodexActivityMap(
      [thread],
      '/definitely-missing-codex-home',
      new Map([[process.pid, process]]),
      { execFile: async () => ({ stdout: `p90403\nn/home/user/.codex/thread-writer-locks/${threadId}.lock\n` }) },
    );
    expect(activity.get(threadId)).toMatchObject({ active: true, pid: 90403, tty: 's000' });
  });

  it('keeps identity unbound when a process holds ambiguous thread locks', async () => {
    const otherId = '01a0d4e6-42a3-7771-a56e-46d16a2868be';
    const activity = await buildCodexActivityMap(
      [thread, { ...thread, id: otherId }],
      '/definitely-missing-codex-home',
      new Map([[process.pid, process]]),
      { execFile: async () => ({ stdout: `n/home/user/.codex/thread-writer-locks/${threadId}.lock\nn/home/user/.codex/thread-writer-locks/${otherId}.lock\n` }) },
    );
    expect(activity.get(threadId)?.active).not.toBe(true);
    expect(activity.get(otherId)?.active).not.toBe(true);
  });
});
