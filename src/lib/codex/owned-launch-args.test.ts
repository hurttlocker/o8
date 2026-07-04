import { describe, expect, it } from 'vitest';
import { codexLaunchArgs } from './owned';

describe('codex worker launch args (#1402 isolation)', () => {
  it('workers ignore the user config so inherited MCP servers cannot slow or kill them', () => {
    const args = codexLaunchArgs({ cwd: '/tmp/wt', prompt: 'do the task' });
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('exec');
    expect(args[args.length - 1]).toBe('do the task');
  });
});
