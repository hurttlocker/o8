import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveDependencyInstallRecipe,
  runDependencyInstall,
  type DependencyInstallInvocation,
} from './dependency-install';

const roots: string[] = [];
const command = 'npm ci --prefer-offline';
const hostPath = process.env.PATH ?? '';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A fake `npm` that only answers `--version`, so PATH order is observable. */
function fakeManagerDirectory(root: string, name: string, version: string): string {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, 'npm');
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nexit 9\n`);
  chmodSync(executable, 0o755);
  return directory;
}

function fixture(declaration: string | null): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-manager-pinning-'));
  roots.push(root);
  const workspace = path.join(root, 'repo');
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'manager-pinning-fixture',
    version: '1.0.0',
    private: true,
    ...(declaration ? { packageManager: declaration } : {}),
  }));
  writeFileSync(path.join(workspace, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git(workspace, 'init', '-q', '-b', 'main');
  git(workspace, 'add', 'package.json', 'package-lock.json');
  git(workspace, '-c', 'user.name=o8-test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture');
  return workspace;
}

function withPath(directories: string[], operation: () => Promise<void>): Promise<void> {
  process.env.PATH = [...directories, hostPath].join(path.delimiter);
  return operation().finally(() => { process.env.PATH = hostPath; });
}

async function install(
  workspace: string,
): Promise<{ invocation: DependencyInstallInvocation; executable: string; version: string }> {
  let invocation: DependencyInstallInvocation | null = null;
  const receipt = await runDependencyInstall(workspace, command, {
    cacheRoot: path.join(workspace, '.pinning-cache'),
    run: async (candidate) => {
      invocation = candidate;
      mkdirSync(path.join(workspace, 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(path.join(workspace, 'node_modules', 'fixture', 'index.js'), 'private\n');
    },
  });
  return {
    invocation: invocation!,
    executable: receipt.packageManagerExecutable,
    version: receipt.recipe.packageManagerVersion,
  };
}

afterEach(() => {
  process.env.PATH = hostPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('package-manager execution is pinned to the repository declaration', () => {
  it('runs the declared npm even when an older npm sorts first on PATH', async () => {
    const workspace = fixture('npm@11.8.0');
    const older = fakeManagerDirectory(path.dirname(workspace), 'npm-10', '10.9.8');
    const declared = fakeManagerDirectory(path.dirname(workspace), 'npm-11', '11.8.0');

    await withPath([older, declared], async () => {
      const result = await install(workspace);

      expect(result.version).toBe('11.8.0');
      expect(result.executable).toBe(path.join(declared, 'npm'));
      expect(result.invocation.command).toBe(path.join(declared, 'npm'));
      expect(result.invocation.args).toEqual(['ci', '--prefer-offline']);
    });
  });

  it('selects by declared version rather than PATH order in either direction', async () => {
    const workspace = fixture('npm@10.9.8');
    const older = fakeManagerDirectory(path.dirname(workspace), 'npm-10', '10.9.8');
    const newer = fakeManagerDirectory(path.dirname(workspace), 'npm-11', '11.8.0');

    await withPath([newer, older], async () => {
      const recipe = await deriveDependencyInstallRecipe(workspace, command);
      const result = await install(workspace);

      expect(recipe.packageManagerVersion).toBe('10.9.8');
      expect(result.executable).toBe(path.join(older, 'npm'));
      expect(result.invocation.command).toBe(path.join(older, 'npm'));
    });
  });

  it('keeps first-usable-on-PATH resolution for a repository with no declared version', async () => {
    const workspace = fixture(null);
    const first = fakeManagerDirectory(path.dirname(workspace), 'npm-10', '10.9.8');
    const second = fakeManagerDirectory(path.dirname(workspace), 'npm-11', '11.8.0');

    await withPath([first, second], async () => {
      const result = await install(workspace);

      expect(result.version).toBe('10.9.8');
      expect(result.executable).toBe(path.join(first, 'npm'));
      expect(result.invocation.command).toBe(path.join(first, 'npm'));
    });
  });

  it('refuses to install when no PATH entry provides the declared version', async () => {
    const workspace = fixture('npm@99.0.0');
    const older = fakeManagerDirectory(path.dirname(workspace), 'npm-10', '10.9.8');

    await withPath([older], async () => {
      await expect(install(workspace)).rejects.toThrow(
        /No npm 99\.0\.0 executable is on PATH/,
      );
    });
  });
});
