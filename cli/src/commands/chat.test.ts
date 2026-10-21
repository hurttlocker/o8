import { describe, expect, it } from 'vitest';
import { parseChatArgs } from './chat.js';

describe('chat launch options', () => {
  it('defaults to plan and keeps all overrides session-local', () => {
    expect(parseChatArgs([]).execute).toBe(false);
    expect(parseChatArgs(['--no-motion', '--repo', '/repo', '--execute', '--backend', 'codex']))
      .toMatchObject({ execute: true, noMotion: true, values: { '--repo': '/repo', '--backend': 'codex' } });
  });
  it.each([['--plan', '--execute'], ['--backend', 'invented'], ['--effort', 'infinite'], ['--resume', '../secrets']])
  ('rejects invalid routing/options %j', (...args) => expect(() => parseChatArgs(args)).toThrow());
});
