import { describe, expect, it } from 'vitest';

import { opencodeAdapter } from './owned';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session';

describe('declarative OpenCode 2 owned adapter', () => {
  it('renders launch/resume specs and normalizes the V2 JSONL session contract', () => {
    expect(opencodeAdapter.binaryName).toBe('opencode2');
    expect(opencodeAdapter.launchArgs({
      cwd: '/tmp/repo',
      prompt: 'fix the bug',
    })).toEqual([
      'run',
      'fix the bug',
      '--format', 'json',
      '--model', 'opencode/deepseek-v4-flash-free',
      '--auto',
      '--standalone',
    ]);
    expect(opencodeAdapter.resumeArgs({
      threadId: 'ses_123',
      prompt: 'continue',
    })).toEqual([
      'run',
      'continue',
      '--format', 'json',
      '--session', 'ses_123',
      '--model', 'opencode/deepseek-v4-flash-free',
      '--auto',
      '--standalone',
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
      JSON.stringify({ type: 'step_start', timestamp: 1_786_244_124_063, sessionID: 'ses_123' }),
      JSON.stringify({ type: 'tool_use', timestamp: 1_786_244_124_080, part: { tool: 'shell', state: { input: { command: 'pwd' } } } }),
      JSON.stringify({ type: 'text', timestamp: 1_786_244_124_113, part: { text: 'done' } }),
      JSON.stringify({ type: 'step_finish', timestamp: 1_786_244_124_120, part: { reason: 'stop', tokens: { input: 10, output: 2 } } }),
    ].join('\n'), run);

    expect(parsed).toMatchObject({
      threadId: 'ses_123',
      completedTurn: false,
      outcome: 'running',
    });
    expect(parsed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', label: 'shell', text: '{"command":"pwd"}' }),
      expect.objectContaining({ kind: 'message', label: 'OpenCode 2', text: 'done', timestamp: '2026-08-09T02:55:24.113Z' }),
      expect.objectContaining({ kind: 'event', label: 'Step complete' }),
    ]));
  });

  it('keeps archived OpenCode 1 result logs readable', () => {
    const run: OwnedRunRecord = {
      id: 'opencode-v1-run',
      mode: 'launch',
      prompt: 'legacy',
      startedAt: '2026-07-19T00:00:00.000Z',
      finishedAt: '2026-07-19T00:00:01.000Z',
      pid: 123,
      stdoutPath: '/tmp/opencode-v1.jsonl',
      stderrPath: '/tmp/opencode-v1.stderr.log',
      outcome: 'running',
    };
    const parsed = opencodeAdapter.parseRunLog([
      JSON.stringify({ type: 'init', sessionId: 'ses_old' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ text: 'done' }] }),
      JSON.stringify({ type: 'result', usage: { inputTokens: 10, outputTokens: 2 } }),
    ].join('\n'), run);

    expect(parsed).toMatchObject({ threadId: 'ses_old', completedTurn: true, outcome: 'finished' });
  });
});
