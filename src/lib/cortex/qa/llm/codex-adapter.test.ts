import { describe, expect, it } from 'vitest';

import { buildCodexQaArgs, buildCodexQaEnv } from './codex-adapter';

describe('buildCodexQaArgs', () => {
  it('does not leak o8 host NODE_OPTIONS into the temp-cwd Codex child', () => {
    expect(buildCodexQaEnv({
      NODE_OPTIONS: '--import=./scripts/register-server-only-stub.mjs',
      NODE_ENV: 'test',
      PATH: '/usr/bin',
    })).toEqual({ NODE_ENV: 'test', PATH: '/usr/bin', FORCE_COLOR: '0', NO_COLOR: '1' });
  });

  it('pins Terra and xhigh using Codex config flags', () => {
    const args = buildCodexQaArgs({
      model: 'gpt-5.6-terra',
      outputFile: '/tmp/ask-output.txt',
      reasoningEffort: 'xhigh',
    });

    expect(args).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--output-last-message',
      '/tmp/ask-output.txt',
      '--model',
      'gpt-5.6-terra',
      '-c',
      'model_reasoning_effort=xhigh',
    ]);
  });

  it('does not add an effort override when the caller omits it', () => {
    const args = buildCodexQaArgs({
      model: 'gpt-5.6-sol',
      outputFile: '/tmp/ask-output.txt',
    });

    expect(args).not.toContain('-c');
    expect(args.join(' ')).not.toContain('model_reasoning_effort');
  });
});
