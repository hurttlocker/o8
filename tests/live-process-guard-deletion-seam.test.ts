import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resetProcessCwdProbeForTesting } from '@/lib/runtime/process-cwd-snapshot';
import { allowWorktreeRemoval } from '@/lib/worktree/live-process-guard';

async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

describe('allowWorktreeRemoval — the deletion seam reads live process state, not a cached snapshot', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    resetProcessCwdProbeForTesting();
  });

  it('permits removal once the occupying process exits, within the snapshot TTL', async () => {
    resetProcessCwdProbeForTesting();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'o8-seam-'));
    dirs.push(dir);

    // A process whose cwd is inside the tree must block removal.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      cwd: dir,
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(child.pid).toBeGreaterThan(0);

    const whileLive = await allowWorktreeRemoval(dir, { logPrefix: 'seam-test' });
    // Self-check: if the probe cannot see the live process the rest is vacuous.
    expect(whileLive).toBe(false);

    // The refusal above populated the machine cwd snapshot, which is cached for
    // 15s. The process now exits well inside that window; a seam that answered
    // from cache would keep refusing a removal that is already safe.
    child.kill('SIGTERM');
    await waitForProcessExit(child.pid!);

    const afterExit = await allowWorktreeRemoval(dir, { logPrefix: 'seam-test' });
    expect(afterExit).toBe(true);
  }, 30_000);
});
