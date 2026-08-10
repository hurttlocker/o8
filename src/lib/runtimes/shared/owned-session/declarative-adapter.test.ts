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
      sessionDir: '/tmp/session',
      prompt: 'ship it',
    })).toEqual(['run', '--json', '--model', 'test-model', 'ship it']);
    expect(registration.adapter.resumeArgs({
      threadId: 'thread-123',
      sessionDir: '/tmp/session',
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

  it('owns a deterministic session file for CLIs that resume by path', () => {
    const registration = registerDeclarativeOwnedRuntime({
      runtimeId: 'test-session-file-cli',
      surfaceIdPrefix: 'test-session-file-owned:',
      rootEnvVar: 'O8_TEST_SESSION_FILE_ROOT',
      rootDefault: path.join(os.tmpdir(), 'o8-test-session-file-owned'),
      binaryName: 'test-session-file-cli',
      binaryEnvOverride: 'O8_TEST_SESSION_FILE_BIN',
      humanLabel: 'Owned Session File CLI',
      squadShortName: 'Session File CLI',
      launchArgs: ['--session', '{{sessionPath}}', '{{prompt}}'],
      resumeArgs: ['--resume={{sessionPath}}', '{{prompt}}'],
      sessionFileName: 'session.log',
      parseRunLog: { patterns: [{ linePattern: /^(.+)$/, completedTurn: true }] },
    });
    const sessionDir = path.join('/tmp', 'owned-session');

    expect(registration.adapter.launchArgs({
      cwd: '/tmp/repo',
      sessionDir,
      prompt: 'first',
    })).toEqual(['--session', path.join(sessionDir, 'session.log'), 'first']);
    expect(registration.adapter.resumeArgs({
      threadId: path.join(sessionDir, 'session.log'),
      sessionDir,
      prompt: 'second',
    })).toEqual([`--resume=${path.join(sessionDir, 'session.log')}`, 'second']);

    const run: OwnedRunRecord = {
      id: 'run-session-file',
      mode: 'launch',
      prompt: 'first',
      startedAt: '2026-07-19T00:00:00.000Z',
      finishedAt: '2026-07-19T00:00:01.000Z',
      pid: 123,
      stdoutPath: path.join(sessionDir, 'runs', 'run.jsonl'),
      stderrPath: path.join(sessionDir, 'runs', 'run.stderr.log'),
      outcome: 'finished',
    };
    expect(registration.adapter.parseRunLog('done', run).threadId)
      .toBe(path.join(sessionDir, 'session.log'));
  });
});
