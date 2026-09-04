import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertTauriExportInputsSafe } from '../scripts/lib/tauri-export-safety.mjs';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Tauri export input safety', () => {
  it('accepts an isolated standalone dependency tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-tauri-export-safe-'));
    roots.push(root);
    const standalone = join(root, '.next', 'standalone');
    mkdirSync(join(standalone, 'node_modules'), { recursive: true });

    expect(() => assertTauriExportInputsSafe(standalone)).not.toThrow();
  });

  it('refuses linked dependencies without touching their source', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-tauri-export-linked-'));
    const sharedModules = mkdtempSync(join(tmpdir(), 'o8-tauri-export-modules-'));
    roots.push(root, sharedModules);
    const standalone = join(root, '.next', 'standalone');
    const marker = join(sharedModules, 'better-sqlite3', 'binding.node');
    mkdirSync(join(standalone), { recursive: true });
    mkdirSync(join(sharedModules, 'better-sqlite3'), { recursive: true });
    writeFileSync(marker, 'must-survive');
    symlinkSync(sharedModules, join(standalone, 'node_modules'), 'dir');

    expect(() => assertTauriExportInputsSafe(standalone))
      .toThrow('standalone node_modules is a symbolic link');
    expect(existsSync(marker)).toBe(true);
  });
});
