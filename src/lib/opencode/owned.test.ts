import { describe, expect, it } from 'vitest';

import { opencodeAdapter } from './owned';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session';

describe('declarative OpenCode owned adapter', () => {
  it('renders launch/resume specs and normalizes the JSONL session contract', () => {
    expect(opencodeAdapter.launchArgs({
      cwd: '/tmp/repo',
      prompt: 'fix the bug',
    })).toEqual([
      'run',
      'fix the bug',
      '--format', 'json',
      '--model', 'opencode/gpt-5-nano',
    ]);
    expect(opencodeAdapter.resumeArgs({
      threadId: 'ses_123',
      prompt: 'continue',
    })).toEqual([
      'run',
      'continue',
      '--format', 'json',
      '--session', 'ses_123',
      '--model', 'opencode/gpt-5-nano',
    ]);

    const run: OwnedRunRecord = {
      id: 'opencode-run-1',
      mode: 'launch',
      prompt: 'fix the bug',
      startedAt: '2026-07-19T00:00:00.000Z',
      finishedAt: '2026-07-19T00:00:01.000Z',
      pid: 123,
      stdoutPath: '/tmp/opencode.jsonl',
      stderrPath: '/tmp/opencode.stderr.log',
      outcome: 'running',
    };
    const parsed = opencodeAdapter.parseRunLog([
      JSON.stringify({ type: 'init', sessionId: 'ses_123' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ text: 'done' }] }),
      JSON.stringify({ type: 'result', usage: { inputTokens: 10, outputTokens: 2 } }),
    ].join('\n'), run);

    expect(parsed).toMatchObject({
      threadId: 'ses_123',
      completedTurn: true,
      outcome: 'finished',
    });
    expect(parsed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message', label: 'opencode', text: 'done' }),
      expect.objectContaining({ kind: 'event', label: 'Run complete' }),
    ]));
  });
});
