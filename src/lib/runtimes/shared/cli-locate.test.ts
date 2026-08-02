import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readlinkSync, lstatSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { wellKnownCliDirs, scanForBinary, ensureCliSymlink, scanAndLink } from './cli-locate';

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'cli-locate-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function fakeBinary(rel: string[], name: string): string {
  const dir = path.join(home, ...rel);
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, name);
  writeFileSync(bin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  return bin;
}

describe('wellKnownCliDirs', () => {
  it('only returns directories that exist', () => {
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    const dirs = wellKnownCliDirs(home);
    expect(dirs).toContain(path.join(home, '.local', 'bin'));
    expect(dirs).not.toContain(path.join(home, '.bun', 'bin'));
  });

  it('includes per-version nvm bins, newest version first', () => {
    mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v22.11.0', 'bin'), { recursive: true });
    mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin'), { recursive: true });
    const dirs = wellKnownCliDirs(home);
    const v24 = dirs.indexOf(path.join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin'));
    const v22 = dirs.indexOf(path.join(home, '.nvm', 'versions', 'node', 'v22.11.0', 'bin'));
    expect(v24).toBeGreaterThanOrEqual(0);
    expect(v22).toBeGreaterThanOrEqual(0);
    expect(v24).toBeLessThan(v22);
  });
});

describe('scanForBinary', () => {
  it('finds a Claude native install in ~/.local/bin (the v0.1.548 report)', () => {
    const bin = fakeBinary(['.local', 'bin'], 'claude');
    expect(scanForBinary('claude', home)).toBe(bin);
  });

  it('finds an npm-global install inside an nvm version dir', () => {
    const bin = fakeBinary(['.nvm', 'versions', 'node', 'v24.1.0', 'bin'], 'gemini');
    expect(scanForBinary('gemini', home)).toBe(bin);
  });

  it('returns null when the binary is nowhere', () => {
    expect(scanForBinary('definitely-not-a-cli', home)).toBeNull();
  });
});

describe('ensureCliSymlink', () => {
  it('uses CORTEX_IDE_DATA_DIR for the default symlink farm', () => {
    const bin = fakeBinary(['.local', 'bin'], 'isolated-cli');
    const link = ensureCliSymlink('isolated-cli', bin);
    expect(link).toBe(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'bin', 'isolated-cli'));
    expect(readlinkSync(link as string)).toBe(bin);
  });

  it('creates ~/.o8/bin/<name> pointing at the target', () => {
    const bin = fakeBinary(['.local', 'bin'], 'claude');
    const link = ensureCliSymlink('claude', bin, home);
    expect(link).toBe(path.join(home, '.o8', 'bin', 'claude'));
    expect(readlinkSync(link as string)).toBe(bin);
  });

  it('re-points a stale symlink at the new install location', () => {
    const oldBin = fakeBinary(['.claude', 'local'], 'claude');
    const newBin = fakeBinary(['.local', 'bin'], 'claude');
    ensureCliSymlink('claude', oldBin, home);
    const link = ensureCliSymlink('claude', newBin, home);
    expect(readlinkSync(link as string)).toBe(newBin);
  });

  it('never overwrites a real file in ~/.o8/bin', () => {
    const realFile = fakeBinary(['.o8', 'bin'], 'claude');
    const bin = fakeBinary(['.local', 'bin'], 'claude');
    const link = ensureCliSymlink('claude', bin, home);
    expect(link).toBeNull();
    expect(lstatSync(realFile).isSymbolicLink()).toBe(false);
  });

  it('is a no-op when the scan hands back the farm entry itself', () => {
    const target = fakeBinary(['.local', 'bin'], 'codex');
    mkdirSync(path.join(home, '.o8', 'bin'), { recursive: true });
    symlinkSync(target, path.join(home, '.o8', 'bin', 'codex'));
    const link = ensureCliSymlink('codex', path.join(home, '.o8', 'bin', 'codex'), home);
    expect(link).toBe(path.join(home, '.o8', 'bin', 'codex'));
    expect(readlinkSync(link as string)).toBe(target);
  });
});

describe('scanAndLink', () => {
  it('returns the original install path and repairs the farm link', () => {
    const bin = fakeBinary(['.bun', 'bin'], 'opencode');
    const found = scanAndLink('opencode', home);
    expect(found).toBe(bin);
    expect(readlinkSync(path.join(home, '.o8', 'bin', 'opencode'))).toBe(bin);
  });
});
