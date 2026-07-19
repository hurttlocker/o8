import { describe, expect, it } from 'vitest';

import { hasLiveProcessInside, probeLiveProcessInside } from './live-process-guard';

describe('live-process guard lsof taxonomy', () => {
  it('ANDs the recursive scan with cwd descriptors so watcher file handles do not count', async () => {
    let observedArgs: string[] = [];
    const runLsof = async (_target: string, args: string[]) => {
      observedArgs = args;
      throw { code: 1, stdout: '', stderr: '' };
    };

    await expect(hasLiveProcessInside('/tmp/worktree', { runLsof })).resolves.toBe(false);
    expect(observedArgs).toEqual(['-a', '-d', 'cwd', '+D', '/tmp/worktree', '-t']);
  });

  it('fails closed when lsof exits 1 with empty stdout but a partial-scan warning', async () => {
    const runLsof = async () => {
      throw {
        code: 1,
        stdout: '',
        stderr: 'lsof: WARNING: can\'t opendir(/tmp/worktree/locked): Permission denied',
      };
    };

    await expect(hasLiveProcessInside('/tmp/worktree', { runLsof })).resolves.toBe(true);
    await expect(probeLiveProcessInside('/tmp/worktree', { runLsof })).resolves.toMatchObject({
      status: 'inconclusive',
      reason: expect.stringContaining('Permission denied'),
    });
  });

  it('accepts exit 1 as clear only when stdout and stderr are both empty', async () => {
    const runLsof = async () => {
      throw { code: 1, stdout: '', stderr: '' };
    };

    await expect(hasLiveProcessInside('/tmp/worktree', { runLsof })).resolves.toBe(false);
  });
});
