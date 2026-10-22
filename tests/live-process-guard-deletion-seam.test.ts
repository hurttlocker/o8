import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readProcessCwdProbeDiagnostics, readProcessCwdSnapshot, resetProcessCwdProbeForTesting } from '@/lib/runtime/process-cwd-snapshot';
import { allowWorktreeRemoval, checkWorktreeRemoval } from '@/lib/worktree/live-process-guard';

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

  it.each(['clear', 'unavailable'] as const)(
    'refuses a late holder after an older %s in-flight scan settles (#4166)', async (olderResult) => {
      resetProcessCwdProbeForTesting();
      const dir = mkdtempSync(path.join(os.tmpdir(), 'o8-seam-inflight-'));
      dirs.push(dir);
      let release!: () => void;
      let started!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const scanning = new Promise<void>(resolve => { started = resolve; });
      // Model evidence already captured by an inventory scan before the new
      // holder exists. The forced guard itself uses the real native reader.
      const inventory = readProcessCwdSnapshot({ execFile: async () => {
        const stdout = `p${process.pid}\ncnode\nn${process.cwd()}\n`;
        started();
        await pending;
        if (olderResult === 'unavailable') throw new Error('older inventory probe failed');
        return { stdout };
      } });
      await scanning;
      const holder = spawn(process.execPath, ['-e', 'process.stdout.write("ready");process.stdin.resume();'], {
        cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
      });
      try {
        await once(holder.stdout!, 'data');
        const sharedInventory = readProcessCwdSnapshot();
        const guard = checkWorktreeRemoval(dir, { logPrefix: 'inflight-seam-test' });
        release();
        const older = await inventory;
        expect(older.status).toBe(olderResult === 'clear' ? 'ready' : 'unavailable');
        expect(await sharedInventory).toEqual(older);
        expect(await guard).toEqual({ allowed: false, refusal: 'live' });
        expect(readProcessCwdProbeDiagnostics()).toMatchObject({
          lsofInvocations: 2, singleFlightJoins: 1, inflight: false,
        });
      } finally {
        release();
        await inventory;
        const closed = once(holder, 'close');
        holder.stdin!.end();
        await closed;
      }
    }, 30_000,
  );

  it('permits removal once the occupying process exits, within the snapshot TTL', async () => {
    resetProcessCwdProbeForTesting();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'o8-seam-'));
    dirs.push(dir);

    // A process whose cwd is inside the tree must block removal.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      cwd: dir,
      stdio: 'ignore',
    });
    const childPid = child.pid;
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(childPid).toBeGreaterThan(0);

      const whileLive = await allowWorktreeRemoval(dir, { logPrefix: 'seam-test' });
      // Self-check: if the probe cannot see the live process the rest is vacuous.
      expect(whileLive).toBe(false);

      // The refusal above populated the machine cwd snapshot, which is cached for
      // 15s. The process now exits well inside that window; a seam that answered
      // from cache would keep refusing a removal that is already safe.
      child.kill('SIGTERM');
      await waitForProcessExit(childPid!);

      const afterExit = await allowWorktreeRemoval(dir, { logPrefix: 'seam-test' });
      expect(afterExit).toBe(true);
    } finally {
      child.kill('SIGKILL');
      if (childPid) await waitForProcessExit(childPid);
    }
  }, 30_000);
});
