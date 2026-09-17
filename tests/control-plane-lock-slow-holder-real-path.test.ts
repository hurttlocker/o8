/**
 * #2399 — a slow (not dead) holder of the cross-process control-plane lock
 * must not lose its state write.
 *
 * Before the fix, a waiter gave up after its budget and ran its
 * read-modify-write without the lock, and a holder older than ten seconds was
 * treated as crashed. Either way the writer that landed second replaced the
 * other's packet. These tests hold the lock from a REAL child process running
 * the REAL withLockedState and write from this process through the same entry
 * point, then read the persisted orchestrator-state.json.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-control-plane-slow-holder-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CONTROL_PLANE_LOCK_WAIT_BUDGET_MS = '300';
process.env.O8_CONTROL_PLANE_LOCK_HARD_CEILING_MS = '30000';

const { readControlPlaneLockEvents, withLockedState } = await import('@/lib/orchestrator/control-plane');

const STATE_PATH = join(dataDir, 'orchestrator-state.json');
const LOCK_DIR = `${STATE_PATH}.lock`;
const EVENTS_PATH = join(dataDir, 'control-plane-lock-events.jsonl');
const children: ChildProcessWithoutNullStreams[] = [];

function packet(id: string): OrchestratorPacket {
  return { id, title: id, summary: `written by ${id}` } as unknown as OrchestratorPacket;
}

function persistedPacketIds(): string[] {
  const file = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as { mission: { packets: Array<{ id: string }> } };
  return file.mission.packets.map((entry) => entry.id).sort();
}

/**
 * A child that takes the lock through withLockedState, adds `packetId`, prints
 * LOCKED, then holds the lock until `holdMs` elapses or `releaseWhenPacket`
 * appears in the persisted file, and prints DONE after its write.
 */
function holdLockInChild(options: {
  packetId: string;
  holdMs?: number;
  releaseWhenPacket?: string;
  hardCeilingMs: number;
}) {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/lib/orchestrator/control-plane.ts')).href;
  const script = `
    import { readFileSync } from 'node:fs';
    const controlPlane = await import(${JSON.stringify(moduleUrl)});
    const withLockedState = controlPlane.withLockedState ?? controlPlane.default?.withLockedState;
    const opts = JSON.parse(process.env.O8_TEST_HOLD);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const persisted = () => {
      try { return readFileSync(opts.statePath, 'utf8'); } catch { return ''; }
    };
    await withLockedState(async (state) => {
      state.packets.push({ id: opts.packetId, title: opts.packetId, summary: 'written by ' + opts.packetId });
      process.stdout.write('LOCKED\\n');
      const deadline = Date.now() + 20000;
      if (opts.holdMs) await sleep(opts.holdMs);
      if (opts.releaseWhenPacket) {
        while (!persisted().includes(opts.releaseWhenPacket) && Date.now() < deadline) await sleep(20);
      }
      return state;
    });
    process.stdout.write('DONE\\n');
  `;
  const child = spawn(process.execPath, ['--import=tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=react-server'].filter(Boolean).join(' '),
      O8_CONTROL_PLANE_LOCK_HARD_CEILING_MS: String(options.hardCeilingMs),
      O8_TEST_HOLD: JSON.stringify({ ...options, statePath: STATE_PATH }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const waitFor = async (text: string) => {
    const deadline = Date.now() + 30_000;
    while (!stdout.includes(text)) {
      if (child.exitCode !== null && !stdout.includes(text)) {
        throw new Error(`lock child exited before ${text}: ${stdout}${stderr}`);
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${text}: ${stdout}${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { child, waitFor };
}

afterEach(() => {
  rmSync(STATE_PATH, { force: true });
  rmSync(EVENTS_PATH, { force: true });
  rmSync(LOCK_DIR, { recursive: true, force: true });
});

afterAll(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('control-plane lock with a slow holder (#2399)', () => {
  it('waits for a live holder past the budget instead of overwriting its write', async () => {
    // Migrate the data dir before two processes open it.
    await withLockedState(() => undefined);
    const holder = holdLockInChild({ packetId: 'pkt-child', holdMs: 1_500, hardCeilingMs: 30_000 });
    await holder.waitFor('LOCKED');

    const startedAt = Date.now();
    await withLockedState((state) => {
      state.packets.push(packet('pkt-parent'));
    });
    const waitedMs = Date.now() - startedAt;
    await holder.waitFor('DONE');

    expect(persistedPacketIds()).toEqual(['pkt-child', 'pkt-parent']);
    expect(waitedMs).toBeGreaterThan(300);
    const slow = readControlPlaneLockEvents().filter((event) => event.kind === 'slow_holder_waited');
    expect(slow).toHaveLength(1);
    expect(slow[0].pid).toBe(process.pid);
    expect(slow[0].holderPid).toBe(holder.child.pid);
    expect(readControlPlaneLockEvents().some((event) => event.kind === 'hard_ceiling_bypassed')).toBe(false);
  }, 60_000);

  it('merges instead of replacing when a live holder passes the hard ceiling', async () => {
    await withLockedState(() => undefined);
    process.env.O8_CONTROL_PLANE_LOCK_HARD_CEILING_MS = '800';
    try {
      // The child keeps the lock until this process has written, so its write
      // lands second: the overwrite the old fallback produced.
      const holder = holdLockInChild({ packetId: 'pkt-child', releaseWhenPacket: 'pkt-parent', hardCeilingMs: 800 });
      await holder.waitFor('LOCKED');

      await withLockedState((state) => {
        state.packets.push(packet('pkt-parent'));
      });
      await holder.waitFor('DONE');

      expect(persistedPacketIds()).toEqual(['pkt-child', 'pkt-parent']);
      const events = readControlPlaneLockEvents();
      const bypass = events.find((event) => event.kind === 'hard_ceiling_bypassed');
      expect(bypass?.pid).toBe(process.pid);
      expect(bypass?.holderPid).toBe(holder.child.pid);
      const childMerge = events.find((event) => event.kind === 'bypass_merged' && event.pid === holder.child.pid);
      expect(childMerge?.preservedPacketIds).toEqual(['pkt-parent']);
      expect(existsSync(LOCK_DIR)).toBe(false);
    } finally {
      process.env.O8_CONTROL_PLANE_LOCK_HARD_CEILING_MS = '30000';
    }
  }, 60_000);

  it('still breaks a fresh lock whose holder process is dead', async () => {
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    children.push(dead as unknown as ChildProcessWithoutNullStreams);
    const deadPid = dead.pid!;
    await new Promise((resolve) => dead.once('exit', resolve));

    mkdirSync(LOCK_DIR, { recursive: true });
    // A fresh timestamp: only liveness, not age, can mark this lock stale.
    writeFileSync(join(LOCK_DIR, 'holder.json'), JSON.stringify({ pid: deadPid, at: Date.now(), token: 'dead' }), 'utf8');

    const startedAt = Date.now();
    await withLockedState((state) => {
      state.packets.push(packet('pkt-after-dead-holder'));
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(persistedPacketIds()).toEqual(['pkt-after-dead-holder']);
    const broken = readControlPlaneLockEvents().filter((event) => event.kind === 'dead_holder_broken');
    expect(broken.map((event) => event.holderPid)).toEqual([deadPid]);
    expect(existsSync(LOCK_DIR)).toBe(false);
  }, 30_000);
});
