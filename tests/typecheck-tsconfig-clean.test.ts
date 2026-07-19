import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('typecheck type generation', () => {
  it('runs the real typegen path without changing tracked tsconfig.json', () => {
    const repoRoot = process.cwd();
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.typecheck).toBe('node scripts/typecheck.mjs');

    const tsconfigPath = join(repoRoot, 'tsconfig.json');
    const before = readFileSync(tsconfigPath, 'utf8');
    const beforeGitDiff = execFileSync('git', ['diff', '--', 'tsconfig.json'], { cwd: repoRoot, encoding: 'utf8' });

    const result = spawnSync('npm', ['run', 'typecheck', '--', '--typegen-only'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(tsconfigPath, 'utf8')).toBe(before);
    expect(execFileSync('git', ['diff', '--', 'tsconfig.json'], { cwd: repoRoot, encoding: 'utf8' }))
      .toBe(beforeGitDiff);
  }, 30_000);
});
