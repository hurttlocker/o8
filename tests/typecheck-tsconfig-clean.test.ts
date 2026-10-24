import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('typecheck type generation', () => {
  it('runs the real typegen path without changing tracked tsconfig.json', () => {
    const repoRoot = process.cwd();

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
    expect(existsSync(join(repoRoot, 'next-env.d.ts'))).toBe(true);
    expect(execFileSync('git', ['check-ignore', 'next-env.d.ts'], { cwd: repoRoot, encoding: 'utf8' }).trim())
      .toBe('next-env.d.ts');
    expect(execFileSync('git', ['ls-files', '--', 'next-env.d.ts'], { cwd: repoRoot, encoding: 'utf8' }).trim())
      .toBe('');
  }, 30_000);
});

describe('typecheck checker selection', () => {
  it.each([
    ['tsrs', 0], ['tsrs', 2], ['tsc', 0], ['tsc', 2],
  ] as const)('runs %s for app and CLI and propagates CLI exit %i', (checker, cliStatus) => {
    const root = mkdtempSync(join(tmpdir(), 'o8-typecheck-runner-'));
    try {
      copyFileSync('scripts/typecheck.mjs', join(root, 'typecheck.mjs'));
      copyFileSync('scripts/typecheck-checker.mjs', join(root, 'typecheck-checker.mjs'));
      copyFileSync('scripts/typecheck-fast.mjs', join(root, 'typecheck-fast.mjs'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        scripts: { 'typecheck:fast': JSON.parse(readFileSync('package.json', 'utf8')).scripts['typecheck:fast']
          .replace('scripts/', '') },
      }));
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      for (const [name, binary, source] of [
        ['next', 'next', `require('node:fs').writeFileSync('tsconfig.json', '{"changed":true}');`],
        [checker === 'tsrs' ? 'tsrs' : 'typescript', checker, `
          const fs = require('node:fs');
          fs.appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
          if (process.argv.includes('--project')) process.exit(${cliStatus});
        `],
      ]) {
        const packageRoot = join(root, 'node_modules', name);
        const binDir = name === 'next' ? 'dist/bin' : 'bin';
        mkdirSync(join(packageRoot, binDir), { recursive: true });
        writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
          name, version: '1.0.0',
          ...(name === 'tsrs' ? { exports: { './package.json': './package.json' } } : {}),
        }));
        writeFileSync(join(packageRoot, binDir, binary), source);
      }
      if (checker === 'tsrs') {
        // Both libc fixtures keep the test portable across GNU and musl hosts.
        for (const suffix of process.platform === 'linux' ? ['-gnu', '-musl'] : ['']) {
          const nativeRoot = join(root, 'node_modules', '@tsrs', `${process.platform}-${process.arch}${suffix}`);
          mkdirSync(nativeRoot, { recursive: true });
          writeFileSync(join(nativeRoot, 'package.json'), '{}');
        }
      }
      const result = spawnSync(process.execPath, ['typecheck.mjs'], { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(cliStatus);
      expect(readFileSync(join(root, 'tsconfig.json'), 'utf8')).toBe('{}');
      expect(readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)))
        .toEqual([['--noEmit'], ['--noEmit', '--project', 'cli/tsconfig.chat.json']]);
      const notice = `tsrs has no ${process.platform}-${process.arch} build; using tsc 5.8.2\n`;
      expect(result.stderr.split(notice)).toHaveLength(checker === 'tsc' ? 2 : 1);

      rmSync(join(root, 'calls.jsonl'));
      const fast = spawnSync('npm', ['run', 'typecheck:fast', '--', '--project', 'cli/tsconfig.chat.json'], {
        cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
      });
      expect(fast.status, fast.stderr).toBe(cliStatus);
      expect(readFileSync(join(root, 'calls.jsonl'), 'utf8').trim()).toBe(
        JSON.stringify(['--noEmit', '--project', 'cli/tsconfig.chat.json']),
      );
      expect(fast.stderr).toBe(checker === 'tsc' ? notice : '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
