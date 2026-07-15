import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { safeJoin, safeJoinReal, confineToRoots, expandHome } from './safe-path';

describe('safeJoin', () => {
  it('joins a relative path inside the root', () => {
    expect(safeJoin('/repo', 'src/index.ts')).toBe('/repo/src/index.ts');
  });

  it('allows the root itself (empty relative)', () => {
    expect(safeJoin('/repo', '')).toBe('/repo');
    expect(safeJoin('/repo', '.')).toBe('/repo');
  });

  it('collapses interior .. that stays inside', () => {
    expect(safeJoin('/repo', 'a/../b')).toBe('/repo/b');
  });

  it('rejects ../ traversal that escapes the root', () => {
    expect(safeJoin('/repo', '../etc/passwd')).toBeNull();
    expect(safeJoin('/repo', 'a/../../etc')).toBeNull();
  });

  it('rejects an absolute path that points outside the root (the CRIT-3 read)', () => {
    // The audited exploit: workspace root + an absolute path to a secret.
    expect(safeJoin('/repo', '/etc/passwd')).toBeNull();
    expect(safeJoin(join(homedir(), 'myrepo'), join(homedir(), '.o8/ws-token'))).toBeNull();
    expect(safeJoin(join(homedir(), 'myrepo'), join(homedir(), '.tauri/cortex-ide.key'))).toBeNull();
  });
});

describe('safeJoinReal', () => {
  it('allows existing files and new paths whose real ancestors remain in the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-safe-root-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'existing.ts'), 'ok');

    expect(safeJoinReal(root, 'src/existing.ts')).toBe(join(root, 'src', 'existing.ts'));
    expect(safeJoinReal(root, 'src/new.ts', { allowMissing: true })).toBe(join(root, 'src', 'new.ts'));
  });

  it('rejects reads and writes through a symlink that escapes the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-safe-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'o8-safe-outside-'));
    writeFileSync(join(outside, 'secret'), 'secret');
    symlinkSync(outside, join(root, 'escape'));

    expect(safeJoinReal(root, 'escape/secret')).toBeNull();
    expect(safeJoinReal(root, 'escape/new-file', { allowMissing: true })).toBeNull();
  });

  it('rejects a broken target symlink instead of treating it as a new file', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-safe-root-'));
    symlinkSync('/definitely/missing/o8-target', join(root, 'broken'));
    expect(safeJoinReal(root, 'broken', { allowMissing: true })).toBeNull();
  });
});

describe('confineToRoots', () => {
  const home = homedir();

  it('accepts a path inside an allowed root', () => {
    expect(confineToRoots(join(home, 'pics/a.png'), [home])).toBe(join(home, 'pics/a.png'));
    expect(confineToRoots('/tmp/x.png', ['/tmp', home])).toBe('/tmp/x.png');
  });

  it('expands ~ before confining', () => {
    expect(confineToRoots('~/pics/a.png', [home])).toBe(join(home, 'pics/a.png'));
  });

  it('rejects normalized ..-traversal that escapes every root', () => {
    // The PL-2 exploit: ~/../../etc/passwd slipped past a plain startsWith.
    expect(confineToRoots('~/../../etc/passwd', [home])).toBeNull();
    expect(confineToRoots('/etc/passwd', ['/tmp', home])).toBeNull();
  });

  it('respects the path separator boundary (no sibling-prefix escape)', () => {
    // /tmproot must NOT be accepted just because it startsWith /tmp.
    expect(confineToRoots('/tmproot/x', ['/tmp'])).toBeNull();
  });
});

describe('expandHome', () => {
  it('expands ~ and ~/… but leaves other paths untouched', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/a')).toBe(join(homedir(), 'a'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('rel/path')).toBe('rel/path');
  });
});
