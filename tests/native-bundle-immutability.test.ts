import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error The executable build script intentionally has no declaration file.
import * as nativeBundle from '../scripts/native-bundle.mjs';

const {
  DEFAULT_APPLE_SIGNING_IDENTITY,
  findMachOBinaries,
  removePackagedNativeBuildOutputs,
  resolveAppleSigningIdentity,
  signMachOBinaries,
} = nativeBundle;

function writeMachO(filePath: string, magic = 'cffaedfe') {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, Buffer.from(`${magic}00000000`, 'hex'));
}

describe('packaged native addon immutability', () => {
  it('removes host-built outputs while preserving immutable prebuilds', () => {
    const serverRoot = mkdtempSync(join(tmpdir(), 'o8-native-bundle-test-'));
    try {
      const packages = [
        ['better-sqlite3', 'better_sqlite3.node'],
        ['node-pty', 'pty.node'],
      ] as const;
      for (const [packageName, addonName] of packages) {
        const moduleRoot = join(serverRoot, 'node_modules', packageName);
        const buildFile = join(moduleRoot, 'build', 'Release', addonName);
        const prebuildFile = join(moduleRoot, 'prebuilds', 'darwin-arm64', addonName);
        mkdirSync(join(moduleRoot, 'build', 'Release'), { recursive: true });
        mkdirSync(join(moduleRoot, 'prebuilds', 'darwin-arm64'), { recursive: true });
        writeFileSync(buildFile, 'host build');
        writeFileSync(prebuildFile, 'packaged prebuild');
      }

      const removed = removePackagedNativeBuildOutputs(serverRoot);

      expect(removed).toHaveLength(2);
      expect(existsSync(join(serverRoot, 'node_modules', 'better-sqlite3', 'build'))).toBe(false);
      expect(existsSync(join(serverRoot, 'node_modules', 'node-pty', 'build'))).toBe(false);
      expect(existsSync(join(serverRoot, 'node_modules', 'better-sqlite3', 'prebuilds', 'darwin-arm64', 'better_sqlite3.node'))).toBe(true);
      expect(existsSync(join(serverRoot, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'))).toBe(true);
    } finally {
      rmSync(serverRoot, { recursive: true, force: true });
    }
  });

  it('finds Mach-O files by magic regardless of extension or executable name', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-native-sign-discovery-'));
    try {
      const addon = join(root, 'package', 'addon.node');
      const helper = join(root, 'package', 'nested', 'spawn-helper');
      writeMachO(addon);
      writeMachO(helper, 'cafebabe');
      writeFileSync(join(root, 'package', 'unsigned.node'), 'not a binary');

      expect(findMachOBinaries(root)).toEqual([helper, addon]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('signs inner-most first with hardened runtime and verifies every binary', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-native-sign-commands-'));
    try {
      const addon = join(root, 'addon.node');
      const helper = join(root, 'nested', 'spawn-helper');
      writeMachO(addon);
      writeMachO(helper);
      const calls: Array<{ command: string; args: string[] }> = [];
      const run = (command: string, args: string[]) => {
        calls.push({ command, args });
        return Buffer.alloc(0);
      };

      const result = signMachOBinaries(root, {
        identity: 'Test Developer ID',
        run,
        log: () => {},
      });

      expect(result.binaries).toEqual([helper, addon]);
      expect(calls).toEqual([
        {
          command: 'codesign',
          args: ['--force', '--timestamp', '--options', 'runtime', '--sign', 'Test Developer ID', helper],
        },
        {
          command: 'codesign',
          args: ['--force', '--timestamp', '--options', 'runtime', '--sign', 'Test Developer ID', addon],
        },
        {
          command: 'codesign',
          args: ['--verify', '--strict', '--verbose=2', helper],
        },
        {
          command: 'codesign',
          args: ['--verify', '--strict', '--verbose=2', addon],
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses APPLE_SIGNING_IDENTITY when set and otherwise uses the documented default', () => {
    expect(resolveAppleSigningIdentity({ APPLE_SIGNING_IDENTITY: ' Custom Identity ' })).toBe('Custom Identity');
    expect(resolveAppleSigningIdentity({})).toBe(DEFAULT_APPLE_SIGNING_IDENTITY);
  });
});
