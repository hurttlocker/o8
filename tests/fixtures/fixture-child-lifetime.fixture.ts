import type { ChildProcess } from 'node:child_process';

/** Own the handles created by one fixture, including children created during teardown. */
export function createFixtureChildLifetime() {
  const children = new Set<ChildProcess>();
  let closing = false;
  const stop = (child: ChildProcess) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };

  return {
    begin() {
      if (children.size) throw new Error('Fixture still owns children from the previous test');
      closing = false;
    },
    track<T extends ChildProcess>(child: T): T {
      children.add(child);
      child.once('close', () => children.delete(child));
      if (closing) stop(child);
      return child;
    },
    activeCount: () => children.size,
    async close() {
      closing = true;
      const deadline = Date.now() + 5_000;
      do {
        for (const child of children) stop(child);
        // Yield through close handlers: they can create another owned child.
        await new Promise(resolve => setTimeout(resolve, 10));
      } while (children.size && Date.now() < deadline);
      if (children.size) throw new Error(`Fixture child teardown timed out with ${children.size} process(es)`);
    },
  };
}
