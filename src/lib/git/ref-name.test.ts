import { describe, it, expect } from 'vitest';
import { isValidGitRefName } from './ref-name';

describe('isValidGitRefName', () => {
  it('accepts ordinary branch names', () => {
    for (const ok of ['main', 'feature/login', 'release-1.2.3', 'worktree/codex/task-42', 'a_b.c']) {
      expect(isValidGitRefName(ok), ok).toBe(true);
    }
  });

  it('rejects git argument injection (leading dash → --upload-pack=)', () => {
    for (const bad of ['--upload-pack=touch /tmp/x', '-rf', '--exec=sh', '-o']) {
      expect(isValidGitRefName(bad), bad).toBe(false);
    }
  });

  it('rejects shell/ref metacharacters and malformed refs', () => {
    for (const bad of ['a b', 'a;b', 'a$(x)', 'a`x`', 'a..b', 'a//b', '/lead', 'trail/', 'x.lock', 'a@{0}', 'a~1', 'a:b', 'a?b', 'a*b', 'a\\b', '']) {
      expect(isValidGitRefName(bad), bad).toBe(false);
    }
  });
});
