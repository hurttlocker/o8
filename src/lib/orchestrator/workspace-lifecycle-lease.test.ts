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
const enter = async (contended) => {
  process.stdout.write('O8_LIFECYCLE_ENTERED ' + String(contended) + '\n');
  if (hold) {
    await new Promise((resolve) => {
      process.stdin.once('data', resolve);
      process.stdin.resume();
    });
  }
};
if (process.env.O8_LIFECYCLE_QUEUE === '1') {
  const queue = await import('./src/lib/worktree/provision-queue.ts');
  await (queue.default ?? queue).withWorktreeProvisionQueue(packetId, (position) => {
    process.stdout.write('O8_QUEUE_POSITION ' + position + '\n');
  }, () => enter(true));
} else {
  await withPacketLifecycleMutationLock(packetId, ({ contended }) => enter(contended));
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

function launch(dataDir: string, hold: boolean, queued = false): ChildProcessWithoutNullStreams {
  const command = resolveTsxProcess(['--conditions=react-server', '--eval', childScript]);
  return spawn(command.file, command.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      O8_DATA_DIR: dataDir,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_LIFECYCLE_PACKET: 'packet-cross-process',
      O8_LIFECYCLE_HOLD: hold ? '1' : '0',
      O8_LIFECYCLE_QUEUE: queued ? '1' : '0',
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

  it('keeps FIFO provisioning across processes and reclaims an owner that dies with its ticket', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-provision-queue-crash-'));
    roots.push(dataDir);
    const children: ChildProcessWithoutNullStreams[] = [];
    const queuedChild = (hold: boolean) => {
      const child = launch(dataDir, hold, true);
      children.push(child);
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      return { child, output: () => output };
    };
    const waitForPosition = async (read: () => string, position: number) => {
      const deadline = Date.now() + 20_000;
      while (!read().includes(`O8_QUEUE_POSITION ${position}\n`)) {
        if (Date.now() > deadline) throw new Error(`Queue position ${position} was not reported: ${read()}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      const owner = queuedChild(true);
      expect(await waitForMarker(owner.child)).toBe(true);
      const second = queuedChild(true);
      await waitForPosition(second.output, 1);
      const third = queuedChild(false);
      await waitForPosition(third.output, 2);
      expect(second.output()).not.toContain('O8_LIFECYCLE_ENTERED');
      expect(third.output()).not.toContain('O8_LIFECYCLE_ENTERED');
      const secondEntered = waitForMarker(second.child);
      const ownerExit = waitForExit(owner.child);
      owner.child.kill('SIGKILL');
      await ownerExit;
      expect(await secondEntered).toBe(true);
      await waitForPosition(third.output, 1);
      expect(third.output()).not.toContain('O8_LIFECYCLE_ENTERED');
      const thirdEntered = waitForMarker(third.child);
      const secondExit = waitForExit(second.child);
      second.child.stdin.end('release\n');
      expect(await secondExit).toBe(0);
      expect(await thirdEntered).toBe(true);
      expect(await waitForExit(third.child)).toBe(0);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await waitForExit(child);
      }
    }
  }, 90_000);

});
