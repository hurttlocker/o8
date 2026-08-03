import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { currentBaseCommit } from '../../scripts/bench/run-coding-end-to-end';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('coding end-to-end benchmark base', () => {
  it('records origin/main when the local checkout has harness-only commits', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-base-'));
    try {
      git(root, ['init', '-q']);
      git(root, ['config', 'user.email', 'bench@example.com']);
      git(root, ['config', 'user.name', 'Benchmark']);
      fs.writeFileSync(path.join(root, 'fixture.txt'), 'base\n');
      git(root, ['add', 'fixture.txt']);
      git(root, ['commit', '-qm', 'base']);
      const remoteBase = git(root, ['rev-parse', 'HEAD']);
      git(root, ['update-ref', 'refs/remotes/origin/main', remoteBase]);

      fs.appendFileSync(path.join(root, 'fixture.txt'), 'local harness\n');
      git(root, ['commit', '-qam', 'local harness']);

      expect(git(root, ['rev-parse', 'HEAD'])).not.toBe(remoteBase);
      expect(currentBaseCommit(root)).toBe(remoteBase);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
