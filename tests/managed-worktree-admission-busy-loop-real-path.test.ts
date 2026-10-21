import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// #3564: during a real dispatch the server's event loop stalled for seconds at a time. A probe
// child that finished in milliseconds was then reported as timed out, because Node ran the
// execFile timeout timer before it handled the child's exit, and admission refused every
// isolated launch. This stalls the loop right after the identity probe spawns its child.
const STALL_MS = 2_500;
const stalledCommands = new Set(['/bin/ps', '/usr/sbin/sysctl', 'powershell.exe']);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = ((...args: Parameters<typeof actual.execFile>) => {
    const child = actual.execFile(...args);
    if (stalledCommands.has(String(args[0]))) {
      setImmediate(() => {
        const until = Date.now() + STALL_MS;
        while (Date.now() < until) { /* a synchronous neighbour holds the loop */ }
      });
    }
    return child;
  }) as typeof actual.execFile;
  // Promisified callers keep Node's own { stdout, stderr } contract; only the callback form stalls.
  Object.assign(execFile, { [promisify.custom]: (actual.execFile as unknown as Record<symbol, unknown>)[promisify.custom] });
  return { ...actual, default: { ...actual, execFile }, execFile };
});

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-admission-busy-loop-')));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const worktreeRoot = join(root, 'worktrees');
const envKeys = ['CORTEX_IDE_DATA_DIR', 'O8_DATA_DIR', 'O8_WORKTREE_ROOT'] as const;
const priorEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = worktreeRoot;

beforeAll(() => {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath, stdio: 'pipe' });
  writeFileSync(join(repoPath, 'README.md'), 'admission under a busy loop\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', [
    '-c', 'user.name=o8 test', '-c', 'user.email=o8@test.invalid', 'commit', '-m', 'init',
  ], { cwd: repoPath, stdio: 'pipe' });
});

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('managed worktree admission on a busy event loop (#3564)', () => {
  it('proves its own process owner and admits the launch while the loop stalls', async () => {
    const { withManagedWorktreeStorageAdmission } = await import('@/lib/worktree/launch-storage-admission');
    const { probeMetadataLockProcessIdentity } = await import('@/lib/worktree/metadata-lock-process-identity');

    const admitted = await withManagedWorktreeStorageAdmission(
      { repoRoot: repoPath, packetId: 'pkt-busy-loop' },
      async (volumeId) => volumeId,
    );
    expect(typeof admitted).toBe('string');
    expect(admitted.length).toBeGreaterThan(0);

    const own = await probeMetadataLockProcessIdentity(process.pid);
    expect(own.state).toBe('live');
  }, 30_000);
});
