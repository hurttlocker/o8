import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readlinkSync, lstatSync, symlinkSync } from 'node:fs';
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

/**
 * Windows locator behaviour (#1758). These run on any host: the module reads
 * `process.platform` at call time, so the suite stubs it and restores after.
 * Without these, a Windows box resolves NO runtime CLI at all — every runtime
 * reports "not installed" and dispatch is impossible.
 */
describe('windows locator', () => {
  const realPlatform = process.platform;
  const realAppData = process.env.APPDATA;

  function asWindows() {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (realAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = realAppData;
  });

  it('scans the npm global bin, where `npm i -g` actually lands', () => {
    asWindows();
    const dir = path.join(home, 'AppData', 'Roaming', 'npm');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\n');
    expect(wellKnownCliDirs(home)).toContain(dir);
    expect(scanForBinary('claude', home)).toBe(path.join(dir, 'claude.cmd'));
  });

  it('prefers the executable extension over the extensionless shell script', () => {
    asWindows();
    const dir = path.join(home, 'AppData', 'Roaming', 'npm');
    mkdirSync(dir, { recursive: true });
    // npm drops BOTH: a POSIX shell script Windows cannot execute, and a .cmd.
    writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n');
    writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\n');
    expect(scanForBinary('claude', home)).toBe(path.join(dir, 'claude.cmd'));
  });

  it('repairs PATH with a forwarding .cmd instead of a privileged symlink', () => {
    asWindows();
    const target = path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '@echo off\r\n');
    const shim = ensureCliSymlink('claude', target, home);
    expect(shim).toBe(path.join(home, '.o8', 'bin', 'claude.cmd'));
    expect(readFileSync(shim!, 'utf-8')).toContain(`"${target}" %*`);
  });

  it('never clobbers a real file a user put in the bin dir', () => {
    asWindows();
    const binDir = path.join(home, '.o8', 'bin');
    mkdirSync(binDir, { recursive: true });
    const mine = path.join(binDir, 'claude.cmd');
    writeFileSync(mine, '@echo off\r\necho hand-written\r\n');
    expect(ensureCliSymlink('claude', path.join(home, 'elsewhere', 'claude.cmd'), home)).toBeNull();
    expect(readFileSync(mine, 'utf-8')).toContain('hand-written');
  });
});

describe('executable extension selection is narrower than PATHEXT', () => {
  const realPlatform = process.platform;
  const realPathext = process.env.PATHEXT;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (realPathext === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = realPathext;
  });

  it('never selects a script extension stock Windows puts in PATHEXT', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC';
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    const dir = path.join(home, 'AppData', 'Roaming', 'npm');
    mkdirSync(dir, { recursive: true });
    // Handing foo.js to cmd runs it under wscript, not node.
    writeFileSync(path.join(dir, 'tool.js'), 'console.log(1)\n');
    expect(scanForBinary('tool', home)).toBeNull();
    writeFileSync(path.join(dir, 'tool.cmd'), '@echo off\r\n');
    expect(scanForBinary('tool', home)).toBe(path.join(dir, 'tool.cmd'));
  });
});
