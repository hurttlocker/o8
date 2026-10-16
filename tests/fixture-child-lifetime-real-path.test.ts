import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createFixtureChildLifetime } from './fixtures/fixture-child-lifetime.fixture';

const worker = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

async function stopControl(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
}

describe('fixture child ownership through real process handles', () => {
  it('stops an owned child without a journal row and preserves an unrelated child', async () => {
    const lifetime = createFixtureChildLifetime();
    const control = spawn(process.execPath, ['-e', 'process.stdin.on("data", () => process.stdout.write("alive"))']);
    const child = lifetime.track(worker());
    try {
      await Promise.all([once(child, 'spawn'), once(control, 'spawn')]);
      await lifetime.close();
      expect(lifetime.activeCount()).toBe(0);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      const reply = once(control.stdout, 'data');
      control.stdin.write('check');
      expect(String((await reply)[0])).toBe('alive');
    } finally {
      await lifetime.close();
      await stopControl(control);
    }
  });

  it('waits for a child created by a close handler during teardown', async () => {
    const lifetime = createFixtureChildLifetime();
    const child = lifetime.track(worker());
    let late: ChildProcess | undefined;
    child.once('close', () => { late = lifetime.track(worker()); });
    try {
      await once(child, 'spawn');
      await lifetime.close();
      expect(late).toBeDefined();
      expect(late!.exitCode !== null || late!.signalCode !== null).toBe(true);
      expect(lifetime.activeCount()).toBe(0);
    } finally {
      await lifetime.close();
    }
  });

  it('stops a child created after teardown has already completed', async () => {
    const lifetime = createFixtureChildLifetime();
    await lifetime.close();
    const child = lifetime.track(worker());
    try {
      await once(child, 'close');
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(lifetime.activeCount()).toBe(0);
    } finally {
      await lifetime.close();
    }
  });
});
