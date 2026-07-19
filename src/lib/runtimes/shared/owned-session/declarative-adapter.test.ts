import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getDeclarativeOwnedRuntime, registerDeclarativeOwnedRuntime } from './declarative-adapter';
import type { OwnedRunRecord } from './types';

describe('declarative owned runtime registry', () => {
  it('turns one config entry into launch, resume, and log parsing behavior', () => {
    const registration = registerDeclarativeOwnedRuntime({
      runtimeId: 'test-declarative-cli',
      surfaceIdPrefix: 'test-declarative-owned:',
      rootEnvVar: 'O8_TEST_DECLARATIVE_ROOT',
      rootDefault: path.join(os.tmpdir(), 'o8-test-declarative-owned'),
      binaryName: 'test-cli',
      binaryEnvOverride: 'O8_TEST_DECLARATIVE_BIN',
      humanLabel: 'Owned Test CLI',
      squadShortName: 'Test CLI',
      defaultModel: 'test-model',
      launchArgs: ['run', '--json', '--model', '{{model}}', '{{prompt}}'],
      resumeArgs: ['resume', '{{threadId}}', '{{prompt}}'],
      parseRunLog: {
        patterns: [
          {
            eventType: 'init',
            threadIdPaths: ['session.id'],
            threadIdPattern: /^thread-/,
          },
          {
            eventType: 'message',
            kind: 'message',
            label: 'Test CLI',
            textPaths: ['content'],
          },
          {
            eventType: 'done',
            kind: 'event',
            label: 'Run complete',
            textPaths: ['summary'],
            completedTurn: true,
          },
        ],
      },
      stderrNoise: [/harmless warning/i],
    });

    expect(getDeclarativeOwnedRuntime('test-declarative-cli')).toBe(registration);
    expect(registration.adapter.binaryName).toBe('test-cli');
    expect(registration.adapter.launchArgs({
      cwd: '/tmp/repo',
      prompt: 'ship it',
    })).toEqual(['run', '--json', '--model', 'test-model', 'ship it']);
    expect(registration.adapter.resumeArgs({
      threadId: 'thread-123',
      prompt: 'continue',
    })).toEqual(['resume', 'thread-123', 'continue']);

    const run: OwnedRunRecord = {
      id: 'run-1',
      mode: 'launch',
      prompt: 'ship it',
      startedAt: '2026-07-19T00:00:00.000Z',
      finishedAt: '2026-07-19T00:00:01.000Z',
      pid: 123,
      stdoutPath: '/tmp/stdout.jsonl',
      stderrPath: '/tmp/stderr.log',
      outcome: 'running',
    };
    const parsed = registration.adapter.parseRunLog([
      JSON.stringify({ type: 'init', session: { id: 'thread-123' } }),
      JSON.stringify({ type: 'message', content: 'working' }),
      JSON.stringify({ type: 'done', summary: 'finished' }),
    ].join('\n'), run);

    expect(parsed).toMatchObject({
      threadId: 'thread-123',
      completedTurn: true,
      outcome: 'finished',
    });
    expect(parsed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message', text: 'working' }),
      expect.objectContaining({ label: 'Run complete', text: 'finished' }),
    ]));
  });
});
