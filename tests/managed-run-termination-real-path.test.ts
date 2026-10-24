import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MANAGED_RUN_PROCESS_PROBE_MAX_BUFFER_BYTES, terminateManagedRun } from '@/lib/runtimes/managed-runs/termination';
import type { ManagedRunRecord } from '@/lib/runtimes/managed-runs/types';

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const sessions: string[] = [];
const processGroups: number[] = [];
const roots: string[] = [];
const fixtureRuns: ManagedRunRecord[] = [];
const originalPath = process.env.PATH;

function useProcessSnapshot(mode: 'large' | 'overflow' | 'failed') {
  const realPs = execFileSync('which', ['ps'], { encoding: 'utf8' }).trim();
  const root = mkdtempSync(join(tmpdir(), 'o8-run-probe-'));
  roots.push(root);
  writeFileSync(join(root, 'ps'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
if (process.argv[2] === 'axeww') {
  if (${JSON.stringify(mode)} === 'failed') process.exit(42);
  require('node:fs').writeFileSync(1, '0 unowned-padding=' + 'x'.repeat(${mode === 'overflow' ? 3 : 1.25} * 1024 * 1024) + '\\n');
}
const result = spawnSync(${JSON.stringify(realPs)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  process.env.PATH = `${root}:${originalPath}`;
}

function restorePath() {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
}

function markerPids(marker: string): number[] {
  const receipt = spawnSync('ps', ['axeww', '-o', 'pid=,command='], {
    encoding: 'utf8', timeout: 3_000, maxBuffer: MANAGED_RUN_PROCESS_PROBE_MAX_BUFFER_BYTES,
  });
  if (receipt.error || receipt.status !== 0) {
    // Never include the snapshot or stderr: ps includes process environments.
    throw new Error(`managed-run fixture process probe failed (code=${(receipt.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'}, status=${receipt.status})`);
  }
  return receipt.stdout.split('\n').flatMap((line) => {
    if (!line.includes(`O8_MANAGED_RUN_MARKER=${marker}`)) return [];
    const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10);
    return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for managed-run fixture');
}

async function cleanupFixtures() {
  while (fixtureRuns.length > 0) {
    const record = fixtureRuns.at(-1)!;
    const receipt = await terminateManagedRun(record, { reason: 'operator_stop', exitCode: null });
    if (!receipt.confirmedDead) throw new Error('managed-run fixture descendants did not settle; retaining scratch data');
    expect(markerPids(record.processMarker!)).toEqual([]);
    fixtureRuns.pop();
  }
  while (sessions.length > 0) {
    try { execFileSync('tmux', ['kill-session', '-t', sessions.pop()!], { stdio: 'ignore' }); } catch {}
  }
  while (processGroups.length > 0) {
    try { process.kill(-processGroups.pop()!, 'SIGKILL'); } catch {}
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
}

afterEach(async () => { restorePath(); await cleanupFixtures(); });

function startFixture() {
  const id = randomUUID().replace(/-/g, '').slice(0, 8);
  const session = `cortex-run-${id}`;
  const marker = randomUUID().replace(/-/g, '');
  const root = mkdtempSync(join(tmpdir(), 'o8-run-termination-ready-'));
  roots.push(root);
  const childReady = join(root, 'child-ready');
  sessions.push(session);
  const childScript = [
    "process.on('SIGINT', () => {})",
    "process.on('SIGTERM', () => {})",
    "process.on('SIGHUP', () => {})",
    `require('node:fs').writeFileSync(${JSON.stringify(childReady)}, 'ready')`,
    'setInterval(() => {}, 1000)',
  ].join(';');
  const fixture = [
    "const { spawn } = require('node:child_process')",
    "process.on('SIGINT', () => {})",
    "process.on('SIGTERM', () => {})",
    "process.on('SIGHUP', () => {})",
    `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' })`,
    'setInterval(() => {}, 1000)',
  ].join(';');
  const record: ManagedRunRecord = {
    id,
    session,
    command: 'signal-resistant parent and grandchild',
    cwd: process.cwd(),
    processMarker: marker,
    mode: 'stream',
    startedAt: new Date().toISOString(),
    status: 'running',
  };

  fixtureRuns.push(record);

  execFileSync('tmux', [
    'new-session', '-d', '-s', session,
    '-e', `O8_MANAGED_RUN_MARKER=${marker}`,
    process.execPath, '-e', fixture,
  ]);
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
  record.panePid = panePid;
  record.processGroupId = processGroupId;
  return { record, childReady };
}

describe.skipIf(!tmuxAvailable)('managed-run process-tree settlement through real tmux', () => {
  it.each(['normal', 'large'] as const)('kills a signal-resistant parent and grandchild with a %s process snapshot', async (snapshot) => {
    if (snapshot === 'large') useProcessSnapshot('large');
    const { record, childReady } = startFixture();
    try {
      await waitFor(() => existsSync(childReady) && markerPids(record.processMarker!).length >= 2);

      const result = await terminateManagedRun(record, {
        reason: 'stream_sigint',
        exitCode: 130,
      });

      expect(result.confirmedDead).toBe(true);
      expect(result.steps.at(-1)?.signal).toBe('SIGKILL');
      expect(markerPids(record.processMarker!)).toEqual([]);
      expect(spawnSync('tmux', ['has-session', '-t', record.session], { stdio: 'ignore' }).status).not.toBe(0);
      sessions.pop();
    } finally {
      restorePath();
      await terminateManagedRun(record, { reason: 'operator_stop', exitCode: null });
    }
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

describe.skipIf(process.platform === 'win32')('managed-run fixture process probe', () => {
  it.each(['failed', 'overflow'] as const)('reports %s snapshots instead of an empty live-process set', (mode) => {
    useProcessSnapshot(mode);
    expect(() => markerPids('fixture-probe')).toThrow(
      mode === 'failed' ? 'status=42' : 'code=ENOBUFS',
    );
  });
});

describe.skipIf(!tmuxAvailable)('managed-run fixture readiness cleanup', () => {
  it('settles owned descendants when the readiness probe fails', async () => {
    const { record, childReady } = startFixture();
    try {
      await waitFor(() => existsSync(childReady));
      useProcessSnapshot('failed');
      await expect(waitFor(() => markerPids(record.processMarker!).length >= 2, 100))
        .rejects.toThrow('managed-run fixture process probe failed');
      restorePath();
      await cleanupFixtures();
      expect(markerPids(record.processMarker!)).toEqual([]);
      expect(spawnSync('tmux', ['has-session', '-t', record.session], { stdio: 'ignore' }).status).not.toBe(0);
    } finally {
      // The red run must also settle its deliberately resistant descendants.
      restorePath();
      await terminateManagedRun(record, { reason: 'operator_stop', exitCode: null });
    }
  }, 15_000);
});
