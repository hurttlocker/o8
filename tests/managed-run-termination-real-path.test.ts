import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { terminateManagedRun } from '@/lib/runtimes/managed-runs/termination';
import type { ManagedRunRecord } from '@/lib/runtimes/managed-runs/types';

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const sessions: string[] = [];
const processGroups: number[] = [];

function markerPids(marker: string): number[] {
  try {
    const output = execFileSync('ps', ['eww', '-axo', 'pid=,command='], { encoding: 'utf8' });
    return output.split('\n').flatMap((line) => {
      if (!line.includes(`O8_MANAGED_RUN_MARKER=${marker}`)) return [];
      const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10);
      return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
    });
  } catch {
    return [];
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for managed-run fixture');
}

afterEach(() => {
  while (sessions.length > 0) {
    try { execFileSync('tmux', ['kill-session', '-t', sessions.pop()!], { stdio: 'ignore' }); } catch {}
  }
  while (processGroups.length > 0) {
    try { process.kill(-processGroups.pop()!, 'SIGKILL'); } catch {}
  }
});

describe.skipIf(!tmuxAvailable)('managed-run process-tree settlement through real tmux', () => {
  it('kills a signal-resistant parent and grandchild and settles the ownership registry evidence', async () => {
    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    const session = `cortex-run-${id}`;
    const marker = randomUUID().replace(/-/g, '');
    sessions.push(session);
    const childScript = [
      "process.on('SIGINT', () => {})",
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)',
    ].join(';');
    const fixture = [
      "const { spawn } = require('node:child_process')",
      "process.on('SIGINT', () => {})",
      "process.on('SIGTERM', () => {})",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 1000)',
    ].join(';');
    execFileSync('tmux', [
      'new-session', '-d', '-s', session,
      '-e', `O8_MANAGED_RUN_MARKER=${marker}`,
      process.execPath, '-e', fixture,
    ]);
    await waitFor(() => markerPids(marker).length >= 2);
    const panePid = Number.parseInt(execFileSync(
      'tmux',
      ['list-panes', '-t', session, '-F', '#{pane_pid}'],
      { encoding: 'utf8' },
    ).trim(), 10);
    const processGroupId = Number.parseInt(execFileSync(
      'ps',
      ['-o', 'pgid=', '-p', String(panePid)],
      { encoding: 'utf8' },
    ).trim(), 10);
    const record: ManagedRunRecord = {
      id,
      session,
      command: 'signal-resistant parent and grandchild',
      cwd: process.cwd(),
      panePid,
      processGroupId,
      processMarker: marker,
      mode: 'stream',
      startedAt: new Date().toISOString(),
      status: 'running',
    };

    const result = await terminateManagedRun(record, {
      reason: 'stream_sigint',
      exitCode: 130,
    });

    expect(result.confirmedDead).toBe(true);
    expect(result.steps.at(-1)?.signal).toBe('SIGKILL');
    expect(markerPids(marker)).toEqual([]);
    expect(spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status).not.toBe(0);
    sessions.pop();
  }, 15_000);

  it('does not signal an unrelated recycled process group when the owned session is absent', async () => {
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    if (!unrelated.pid) throw new Error('unrelated process did not start');
    processGroups.push(unrelated.pid);
    const result = await terminateManagedRun({
      id: 'missing1',
      session: 'cortex-run-missing1',
      command: 'old command',
      cwd: process.cwd(),
      processGroupId: unrelated.pid,
      processMarker: randomUUID().replace(/-/g, ''),
      mode: 'stream',
      startedAt: new Date().toISOString(),
      status: 'running',
    }, {
      reason: 'operator_stop',
      exitCode: null,
    });

    expect(result).toMatchObject({ confirmedDead: true, alreadyDead: true });
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
  });
});
