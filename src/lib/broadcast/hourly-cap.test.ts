import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

process.env.O8_DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'o8-hourly-cap-'));
process.env.CORTEX_IDE_DATA_DIR ??= process.env.O8_DATA_DIR;

const { getSqlite } = await import('@/lib/db');
const { ensureV44BroadcastSchema } = await import('@/lib/db/v44-broadcast-migration');
const { appendBroadcastEvent } = await import('@/lib/broadcast/post');
const { claimBroadcastLineSlot, broadcastGeneratedLinesSince, broadcastHourlyWindowStart } =
  await import('@/lib/broadcast/hourly-cap');

const NOW = new Date('2026-08-24T12:00:00.000Z');
const childStderr = new WeakMap<ChildProcess, () => string>();

function capped(text: string) {
  return appendBroadcastEvent({ kind: 'commentary', actor: 'symon', text }, {
    sqlite: getSqlite(),
    now: NOW,
    metadata: { hourlyCapped: true },
  });
}

function waitForMessage<T>(child: ChildProcess, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child message ${type}`));
    }, 15_000);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== type) return;
      cleanup();
      resolve(message as T);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(
        `Child exited before ${type}: code=${String(code)} signal=${String(signal)} ${childStderr.get(child)?.() ?? ''}`,
      ));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function spawnClaimant(workerId: string, cap: number): { child: ChildProcess; stderr: () => string } {
  const hourlyCapUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/broadcast/hourly-cap.ts')).href;
  const dbUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/db/index.ts')).href;
  const migrationUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/db/v44-broadcast-migration.ts')).href;
  const postUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/broadcast/post.ts')).href;
  const childScript = `
    void (async () => {
    const dbImported = await import(${JSON.stringify(dbUrl)});
    const migrationImported = await import(${JSON.stringify(migrationUrl)});
    const capImported = await import(${JSON.stringify(hourlyCapUrl)});
    const postImported = await import(${JSON.stringify(postUrl)});
    const { getSqlite } = dbImported.default ?? dbImported;
    const { ensureV44BroadcastSchema } = migrationImported.default ?? migrationImported;
    const { claimBroadcastLineSlot } = capImported.default ?? capImported;
    const { appendBroadcastEvent } = postImported.default ?? postImported;
    const sqlite = getSqlite();
    ensureV44BroadcastSchema(sqlite);
    process.send({ type: 'ready' });
    process.once('message', (message) => {
      if (message !== 'claim') return;
      const event = claimBroadcastLineSlot(sqlite, new Date(${JSON.stringify(NOW.toISOString())}), ${cap}, () =>
        appendBroadcastEvent({ kind: 'commentary', actor: 'symon', text: ${JSON.stringify(workerId)} }, {
          sqlite,
          now: new Date(${JSON.stringify(NOW.toISOString())}),
          metadata: { hourlyCapped: true, workerId: ${JSON.stringify(workerId)} },
        }));
      process.send({ type: 'result', claimed: Boolean(event) });
      process.exit(0);
    });
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  let stderrText = '';
  const child = spawn(path.join(process.cwd(), 'node_modules/.bin/tsx'), ['--eval', childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      O8_DATA_DIR: process.env.O8_DATA_DIR,
      CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
      NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), '--conditions=react-server'].filter(Boolean).join(' '),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr?.on('data', (chunk) => { stderrText += String(chunk); });
  childStderr.set(child, () => stderrText);
  return { child, stderr: () => stderrText };
}

describe('claimBroadcastLineSlot (#1840)', () => {
  it('never lets producers exceed the cap, however many race for the last slot', () => {
    const sqlite = getSqlite();
    ensureV44BroadcastSchema(sqlite);
    const before = broadcastGeneratedLinesSince(sqlite, broadcastHourlyWindowStart(NOW));
    const cap = before + 12;

    // Two producers previously each read the same count, each concluded there
    // was room, and both appended -- so the ceiling was soft by however many
    // were running. Every attempt now re-reads inside its own insert's
    // transaction, so only the ones with room actually write.
    let written = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const event = claimBroadcastLineSlot(sqlite, NOW, cap, () => capped(`line ${attempt}`));
      if (event) written += 1;
    }

    expect(written).toBe(12);
    expect(broadcastGeneratedLinesSince(sqlite, broadcastHourlyWindowStart(NOW))).toBe(cap);
  });

  it('refuses without writing once the window is full', () => {
    const sqlite = getSqlite();
    const count = broadcastGeneratedLinesSince(sqlite, broadcastHourlyWindowStart(NOW));
    expect(claimBroadcastLineSlot(sqlite, NOW, count, () => capped('overflow'))).toBeNull();
    expect(broadcastGeneratedLinesSince(sqlite, broadcastHourlyWindowStart(NOW))).toBe(count);
  });

  it('treats a zero or nonsense cap as closed rather than unlimited', () => {
    const sqlite = getSqlite();
    expect(claimBroadcastLineSlot(sqlite, NOW, 0, () => capped('zero'))).toBeNull();
    expect(claimBroadcastLineSlot(sqlite, NOW, -1, () => capped('negative'))).toBeNull();
    expect(claimBroadcastLineSlot(sqlite, NOW, Number.NaN, () => capped('nan'))).toBeNull();
  });

  it('allows only one of two synchronized processes to claim the last slot', async () => {
    const sqlite = getSqlite();
    ensureV44BroadcastSchema(sqlite);
    const before = broadcastGeneratedLinesSince(sqlite, broadcastHourlyWindowStart(NOW));
    const cap = before + 1;
    const claimants = [spawnClaimant('claimant-a', cap), spawnClaimant('claimant-b', cap)];

    try {
      await Promise.all(claimants.map(({ child }) => waitForMessage(child, 'ready')));
      const results = claimants.map(({ child }) => waitForMessage<{ type: 'result'; claimed: boolean }>(child, 'result'));
      const exits = claimants.map(({ child }) => new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
      }));
      for (const { child } of claimants) child.send('claim');

      const settled = await Promise.all(results);
      expect(settled.map((result) => result.claimed).sort()).toEqual([false, true]);
      expect(await Promise.all(exits)).toEqual([0, 0]);
      expect(broadcastGeneratedLinesSince(sqlite, broadcastHourlyWindowStart(NOW))).toBe(cap);
      for (const claimant of claimants) expect(claimant.stderr()).toBe('');
    } finally {
      for (const { child } of claimants) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  });
});
