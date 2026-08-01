import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error The executable build script intentionally has no declaration file.
import { removePackagedNativeBuildOutputs } from '../scripts/native-bundle.mjs';

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
});
