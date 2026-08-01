import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  prepareBetterSqlite3,
  prepareNodePty,
  selectBetterSqlite3Prebuild,
} = require('../scripts/native-addon-runtime.cjs') as {
  prepareBetterSqlite3: (serverRoot: string, arch: string) => void;
  prepareNodePty: (serverRoot: string, arch: string, abi: string) => void;
  selectBetterSqlite3Prebuild: (moduleRoot: string, arch: string, pathExists: (path: string) => boolean) => string;
};

describe('packaged better-sqlite3 architecture selection', () => {
  const moduleRoot = '/bundle/server/node_modules/better-sqlite3';
  const x64 = join(moduleRoot, 'prebuilds', 'darwin-x64', 'better_sqlite3.node');
  const arm64 = join(moduleRoot, 'prebuilds', 'darwin-arm64', 'better_sqlite3.node');
  const available = new Set([x64, arm64]);

  it.each([
    ['x64', x64],
    ['arm64', arm64],
  ])('selects the %s prebuild', (arch, expected) => {
    expect(selectBetterSqlite3Prebuild(moduleRoot, arch, (path) => available.has(path))).toBe(expected);
  });

  it('fails before boot when the matching prebuild is unavailable', () => {
    expect(() => selectBetterSqlite3Prebuild(moduleRoot, 'arm64', (path) => path === x64))
      .toThrow('Missing better-sqlite3 arm64 prebuild');
  });

  it('redirects the binding require without modifying a writable app bundle', () => {
    const serverRoot = mkdtempSync(join(tmpdir(), 'o8-native-runtime-test-'));
    const testModuleRoot = join(serverRoot, 'node_modules', 'better-sqlite3');
    const source = join(testModuleRoot, 'prebuilds', 'darwin-x64', 'better_sqlite3.node');
    const target = join(testModuleRoot, 'build', 'Release', 'better_sqlite3.node');
    try {
      mkdirSync(join(testModuleRoot, 'prebuilds', 'darwin-x64'), { recursive: true });
      mkdirSync(join(testModuleRoot, 'build', 'Release'), { recursive: true });
      writeFileSync(source, 'prebuild');
      writeFileSync(target, 'local build');

      prepareBetterSqlite3(serverRoot, 'x64');

      expect(require.resolve(target)).toBe(source);
      expect(readFileSync(target, 'utf8')).toBe('local build');
    } finally {
      rmSync(serverRoot, { recursive: true, force: true });
    }
  });

  it('leaves the packaged node-pty addon and helper untouched', () => {
    const serverRoot = mkdtempSync(join(tmpdir(), 'o8-node-pty-runtime-test-'));
    const moduleRoot = join(serverRoot, 'node_modules', 'node-pty');
    const abi = process.versions.modules;
    const selectedDir = join(moduleRoot, 'prebuilds', `node-v${abi}`, 'darwin-x64');
    const loaderDir = join(moduleRoot, 'prebuilds', 'darwin-x64');
    const targetDir = join(moduleRoot, 'build', 'Release');
    try {
      for (const directory of [selectedDir, loaderDir, targetDir]) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'pty.node'), directory === targetDir ? 'host addon' : 'prebuild');
        writeFileSync(join(directory, 'spawn-helper'), directory === targetDir ? 'host helper' : 'prebuild');
      }

      prepareNodePty(serverRoot, 'x64', abi);

      expect(readFileSync(join(targetDir, 'pty.node'), 'utf8')).toBe('host addon');
      expect(readFileSync(join(targetDir, 'spawn-helper'), 'utf8')).toBe('host helper');
    } finally {
      rmSync(serverRoot, { recursive: true, force: true });
    }
  });
});
