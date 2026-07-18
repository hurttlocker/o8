import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  workerSandboxEnabled,
  buildSeatbeltProfile,
  prepareWorkerSandbox,
  SandboxUnavailableError,
  SANDBOX_EXEC_PATH,
} from './sandbox';

const isDarwin = process.platform === 'darwin';
const tmpRoots: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.O8_WORKER_SANDBOX;
  while (tmpRoots.length) {
    const dir = tmpRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('workerSandboxEnabled — feature gate default OFF', () => {
  it('is off when unset (dispatch must never brick on day one)', () => {
    delete process.env.O8_WORKER_SANDBOX;
    expect(workerSandboxEnabled()).toBe(false);
  });

  it('accepts on/1/true/yes and rejects off/anything else', () => {
    for (const on of ['on', '1', 'true', 'yes', 'ON', 'Yes']) {
      process.env.O8_WORKER_SANDBOX = on;
      expect(workerSandboxEnabled()).toBe(true);
    }
    for (const off of ['off', '0', 'false', 'no', '', 'maybe']) {
      process.env.O8_WORKER_SANDBOX = off;
      expect(workerSandboxEnabled()).toBe(false);
    }
  });
});

describe('buildSeatbeltProfile — policy shape', () => {
  const profile = buildSeatbeltProfile({
    worktreePath: '/tmp/wt',
    repoPath: '/tmp/repo',
    homeDir: '/Users/op',
    tmpDir: '/tmp/T',
  });

  it('is deny-by-default', () => {
    expect(profile).toContain('(deny default)');
  });

  it('DENIES the operator secret trees (~/.o8, ~/.tauri) and the webview socket', () => {
    // Secret trees are denied explicitly, AFTER the allows (last-match-wins).
    const denyIdx = profile.indexOf('(deny file-read* file-write*\n  (subpath "/Users/op/.o8")');
    expect(denyIdx).toBeGreaterThan(-1);
    expect(profile).toContain('(subpath "/Users/op/.tauri")');
    expect(profile).toContain('#"^/private/tmp/tauri-mcp-o8-"');
    expect(profile).toContain('#"^/tmp/tauri-mcp-o8-"');
    // The secret deny must come after the worktree allow (SBPL last-match-wins).
    const allowIdx = profile.indexOf('(allow file-read* file-write*');
    expect(allowIdx).toBeGreaterThan(-1);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  it('DENIES the gh credential store and never allow-lists ~/.zshenv', () => {
    // ~/.config is read-allowed for git, but the gh token store inside it is
    // denied last so a worker cannot lift the operator's GitHub OAuth token.
    const ghDenyIdx = profile.indexOf('(subpath "/Users/op/.config/gh")');
    expect(ghDenyIdx).toBeGreaterThan(profile.indexOf('(allow file-read* file-write*'));
    // ~/.zshenv commonly exports operator API keys; workers inherit env from
    // the trusted parent, so it must not appear in any allow.
    expect(profile).not.toContain('.zshenv');
  });

  it('ALLOWS the worktree + repo read+write and keeps network open (RF-1 HTTP)', () => {
    expect(profile).toContain('(subpath "/tmp/wt")');
    expect(profile).toContain('(subpath "/tmp/repo")');
    expect(profile).toContain('(allow network*)');
  });

  it('does NOT whitelist HOME wholesale (so ~/.o8 stays out of the read allowlist)', () => {
    expect(profile).not.toContain('(subpath "/Users/op")\n');
    // toolchain subdirs are allowed, but never .o8 as a READ root
    expect(profile).toContain('(subpath "/Users/op/.codex")');
  });
});

describe('prepareWorkerSandbox — the exact wrapper store.ts spawns', () => {
  it.skipIf(!isDarwin)('wraps binary+args with sandbox-exec -f <profile> (enabled path)', async () => {
    const worktree = tmpRoot('o8-sbx-wt-');
    const profileDir = tmpRoot('o8-sbx-prof-');
    const prepared = await prepareWorkerSandbox({
      runId: 'run-123',
      profileDir,
      cwd: worktree,
      repoPath: worktree,
      binary: '/usr/local/bin/codex',
      args: ['exec', '--json', 'do the thing'],
    });

    // (a) wrapper + profile args are present and ordering is exact.
    expect(prepared.binary).toBe(SANDBOX_EXEC_PATH);
    expect(prepared.args[0]).toBe('-f');
    expect(prepared.args[1]).toBe(prepared.profilePath);
    expect(prepared.args[2]).toBe('/usr/local/bin/codex');
    expect(prepared.args.slice(3)).toEqual(['exec', '--json', 'do the thing']);
    expect(existsSync(prepared.profilePath)).toBe(true);

    // (b) generated profile denies ~/.o8 and allows the worktree.
    expect(prepared.profileText).toContain(`(subpath "${path.join(os.homedir(), '.o8')}")`);
  });

  it('is FAIL-CLOSED — throws SandboxUnavailableError when the profile cannot be written', async () => {
    if (!isDarwin) {
      // On a non-darwin host the platform guard is the fail-closed trigger.
      await expect(prepareWorkerSandbox({
        runId: 'r', profileDir: '/tmp', cwd: '/tmp', repoPath: '/tmp',
        binary: '/bin/echo', args: [],
      })).rejects.toBeInstanceOf(SandboxUnavailableError);
      return;
    }
    // darwin: an unwritable profile dir must refuse, never spawn unsandboxed.
    await expect(prepareWorkerSandbox({
      runId: 'r',
      profileDir: '/this/path/does/not/exist/and/is/unwritable',
      cwd: '/tmp',
      repoPath: '/tmp',
      binary: '/bin/echo',
      args: [],
    })).rejects.toBeInstanceOf(SandboxUnavailableError);
  });
});

// The reachability proof: the generated policy, run through the REAL
// sandbox-exec, actually blocks a secret read and permits a worktree read.
describe('sandbox policy is live-enforced (real sandbox-exec)', () => {
  it.skipIf(!isDarwin)('denies ~/.o8-style secret reads, allows the worktree', async () => {
    const home = tmpRoot('o8-sbx-home-');
    const secretDir = path.join(home, '.o8');
    // create the fake secret tree
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(path.join(secretDir, 'ws-token'), 'TOPSECRET');

    const worktree = tmpRoot('o8-sbx-wt-');
    writeFileSync(path.join(worktree, 'code.ts'), 'export const ok = true;');
    const profileDir = tmpRoot('o8-sbx-prof-');

    const prepared = await prepareWorkerSandbox({
      runId: 'live',
      profileDir,
      cwd: worktree,
      repoPath: worktree,
      binary: '/bin/cat',
      args: [],
      homeDir: home,
    });
    const profileArg = prepared.args[1];

    // ALLOW: reading a worktree file succeeds.
    const out = execFileSync(SANDBOX_EXEC_PATH,
      ['-f', profileArg, '/bin/cat', path.join(worktree, 'code.ts')],
      { encoding: 'utf8' });
    expect(out).toContain('export const ok = true;');

    // DENY: reading the operator secret is refused (non-zero exit).
    let denied = false;
    try {
      execFileSync(SANDBOX_EXEC_PATH,
        ['-f', profileArg, '/bin/cat', path.join(secretDir, 'ws-token')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
  });
});
