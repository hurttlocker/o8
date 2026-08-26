import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { resolveTsxProcess } from '@/lib/testing/tsx-process';

const roots: string[] = [];
const childScript = String.raw`
void (async () => {
const packetId = process.env.O8_LIFECYCLE_PACKET;
const hold = process.env.O8_LIFECYCLE_HOLD === '1';
const imported = await import('./src/lib/orchestrator/lifecycle-mutation-lock.ts');
const { withPacketLifecycleMutationLock } = imported.default ?? imported;
process.stdout.write('O8_LIFECYCLE_ATTEMPT\n');
await withPacketLifecycleMutationLock(packetId, async ({ contended }) => {
  process.stdout.write('O8_LIFECYCLE_ENTERED ' + String(contended) + '\n');
  if (hold) {
    await new Promise((resolve) => {
      process.stdin.once('data', resolve);
      process.stdin.resume();
    });
  }
});
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

function launch(dataDir: string, hold: boolean): ChildProcessWithoutNullStreams {
  const command = resolveTsxProcess(['--eval', childScript]);
  return spawn(command.file, command.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      O8_DATA_DIR: dataDir,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_LIFECYCLE_PACKET: 'packet-cross-process',
      O8_LIFECYCLE_HOLD: hold ? '1' : '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function waitForAttempt(child: ChildProcessWithoutNullStreams): Promise<void> {
  let output = '';
  let errorOutput = '';
  return new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('O8_LIFECYCLE_ATTEMPT')) resolve();
    });
    child.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString(); });
    child.once('exit', (code) => {
      if (!output.includes('O8_LIFECYCLE_ATTEMPT')) {
        reject(new Error(`Lifecycle child exited ${code}: ${output}${errorOutput}`));
      }
    });
  });
}

async function waitForMarker(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  let output = '';
  let errorOutput = '';
  return new Promise<boolean>((resolve, reject) => {
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/O8_LIFECYCLE_ENTERED (true|false)/);
      if (match) resolve(match[1] === 'true');
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString(); });
    child.once('exit', (code) => {
      if (!output.includes('O8_LIFECYCLE_ENTERED')) {
        reject(new Error(`Lifecycle child exited ${code}: ${output}${errorOutput}`));
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(null);
  return new Promise((resolve) => child.once('exit', resolve));
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('cross-process workspace lifecycle lease', () => {
  it('orders a second Node process behind the exact packet owner', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-lifecycle-lease-order-'));
    roots.push(dataDir);
    const first = launch(dataDir, true);
    expect(await waitForMarker(first)).toBe(false);

    const second = launch(dataDir, false);
    await waitForAttempt(second);
    let secondEntered = false;
    const secondMarker = waitForMarker(second).then((contended) => {
      secondEntered = true;
      return contended;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondEntered).toBe(false);

    const firstExit = waitForExit(first);
    first.stdin.end('release\n');
    expect(await firstExit).toBe(0);
    expect(await secondMarker).toBe(true);
    expect(await waitForExit(second)).toBe(0);
  }, 20_000);

  it('reclaims a crashed exact process owner before the next mutation enters', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-lifecycle-lease-crash-'));
    roots.push(dataDir);
    const crashed = launch(dataDir, true);
    expect(await waitForMarker(crashed)).toBe(false);
    const crashedExit = waitForExit(crashed);
    crashed.kill('SIGKILL');
    expect(await crashedExit).not.toBe(0);

    const replacement = launch(dataDir, false);
    expect(await waitForMarker(replacement)).toBe(true);
    expect(await waitForExit(replacement)).toBe(0);
  }, 20_000);
});
