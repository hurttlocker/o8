import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runLaneRebaseLint } from './rebase-lint';

const tempDirs: string[] = [];

function makeDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `o8-rebase-lint-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c', 'user.name=o8-test',
    '-c', 'user.email=o8@example.test',
    'commit',
    '-m',
    message,
  ]);
}

function writePackage(cwd: string, lintScript = 'eslint .'): void {
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    private: true,
    scripts: lintScript ? { lint: lintScript } : {},
    devDependencies: { eslint: '^9.39.5' },
  }));
}

function initLintRepo(label: string): string {
  const repo = makeDir(label);
  git(repo, ['init', '-b', 'main']);
  writePackage(repo);
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(repo, 'eslint.config.mjs'), [
    'export default [{',
    "  files: ['**/*.js'],",
    "  rules: { 'no-console': 'warn', 'no-unused-vars': 'warn' },",
    '}];',
    '',
  ].join('\n'));
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(repo, 'node_modules'), 'junction');
  return repo;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runLaneRebaseLint', () => {
  it('skips when the repository has no lint script or ESLint config', async () => {
    const noScript = makeDir('no-script');
    writePackage(noScript, '');
    writeFileSync(path.join(noScript, 'eslint.config.mjs'), 'export default [];\n');
    await expect(runLaneRebaseLint({
      cwd: noScript,
      baseRef: 'main',
      actualBranch: 'packet/no-script',
      logPrefix: 'test',
    })).resolves.toEqual({ ok: true, skipped: 'package.json has no lint script' });

    const noConfig = makeDir('no-config');
    writePackage(noConfig);
    await expect(runLaneRebaseLint({
      cwd: noConfig,
      baseRef: 'main',
      actualBranch: 'packet/no-config',
      logPrefix: 'test',
    })).resolves.toEqual({ ok: true, skipped: 'no ESLint config was found' });
  });

  it('allows a changed file whose warning count does not increase and blocks a new warning', async () => {
    const repo = initLintRepo('warning-diff');
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\n');
    commitAll(repo, 'base');
    git(repo, ['checkout', '-b', 'packet/warnings']);
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\nexport const value = 1;\n');
    commitAll(repo, 'keep warning count');

    await expect(runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warnings',
      logPrefix: 'test',
    })).resolves.toEqual({ ok: true });

    writeFileSync(
      path.join(repo, 'src', 'packet.js'),
      'console.log("base");\nconsole.log("new");\nexport const value = 1;\n',
    );
    commitAll(repo, 'add warning');

    const result = await runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warnings',
      logPrefix: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('src/packet.js:2:no-console');
  }, 20_000);

  it('blocks a new warning identity when a different base warning was fixed', async () => {
    const repo = initLintRepo('warning-swap');
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\n');
    commitAll(repo, 'base warning');
    git(repo, ['checkout', '-b', 'packet/warning-swap']);
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'const replacement = 1;\nexport const value = 1;\n');
    commitAll(repo, 'swap warning');

    const result = await runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warning-swap',
      logPrefix: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.output).toContain('src/packet.js:1:no-unused-vars');
      expect(result.output).not.toContain('no-console');
    }
  }, 20_000);

  it('allows an unchanged warning identity after its line shifts', async () => {
    const repo = initLintRepo('warning-shift');
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\n');
    commitAll(repo, 'base warning');
    git(repo, ['checkout', '-b', 'packet/warning-shift']);
    writeFileSync(
      path.join(repo, 'src', 'packet.js'),
      'export const value = 1;\n\nconsole.log("base");\n',
    );
    commitAll(repo, 'shift warning');

    await expect(runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warning-shift',
      logPrefix: 'test',
    })).resolves.toEqual({ ok: true });
  }, 20_000);

  it('turns the hard timeout into a skipped receipt', async () => {
    const repo = makeDir('timeout');
    git(repo, ['init', '-b', 'main']);
    writePackage(repo);
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(path.join(repo, 'eslint.config.mjs'), 'export default [];\n');
    mkdirSync(path.join(repo, 'node_modules', 'eslint', 'bin'), { recursive: true });
    writeFileSync(path.join(repo, 'node_modules', 'eslint', 'package.json'), JSON.stringify({
      name: 'eslint',
      version: '9.0.0',
    }));
    const eslintScript = path.join(repo, 'node_modules', 'eslint', 'bin', 'eslint.js');
    writeFileSync(eslintScript, '#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n');
    chmodSync(eslintScript, 0o755);
    writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    commitAll(repo, 'base');
    git(repo, ['checkout', '-b', 'packet/timeout']);
    writeFileSync(path.join(repo, 'packet.js'), 'export const value = 1;\n');
    commitAll(repo, 'packet');

    const result = await runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/timeout',
      logPrefix: 'test',
      timeoutMs: 100,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skipped).toContain('timeout');
  });
});
