import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveTsxProcess } from '@/lib/testing/tsx-process';

let worktreePath: string | null = null;
let worktreeRegistered = false;

afterEach(() => {
  if (!worktreePath) return;
  try {
    if (worktreeRegistered) {
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: process.cwd(),
        stdio: 'ignore',
      });
    }
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    worktreePath = null;
    worktreeRegistered = false;
  }
});

describe('tsx cross-process resolution from a linked worktree', () => {
  it('runs through the primary checkout when the worktree has no dependencies', () => {
    worktreePath = mkdtempSync(path.join(os.tmpdir(), 'o8-tsx-linked-worktree-'));
    rmSync(worktreePath, { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    worktreeRegistered = true;

    expect(existsSync(path.join(worktreePath, 'node_modules/.bin/tsx'))).toBe(false);
    const command = resolveTsxProcess([
      '--eval',
      'process.stdout.write(process.cwd())',
    ], worktreePath);

    expect(command.file).toBe(process.execPath);
    expect(command.args[0]).toContain(`${path.sep}node_modules${path.sep}tsx${path.sep}`);
    expect(execFileSync(command.file, command.args, {
      cwd: worktreePath,
      encoding: 'utf8',
    })).toBe(realpathSync(worktreePath));
  });

  it('fails immediately with the checked dependency root when tsx is unavailable', () => {
    worktreePath = mkdtempSync(path.join(os.tmpdir(), 'o8-tsx-no-dependencies-'));

    expect(() => resolveTsxProcess(['--eval', ''], worktreePath!)).toThrow(
      `Unable to resolve tsx/cli for a cross-process test from ${path.resolve(worktreePath)}`,
    );
  });
});
