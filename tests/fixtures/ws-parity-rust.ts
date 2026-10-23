import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

/** Start only the explicitly enabled prototype; the producer pipe stays open. */
export async function startRustParity(binary: string, token: string, initialState: string) {
  const child = execFile(binary, ['--experimental-ws', '--listen', '127.0.0.1:0',
    '--initial-state', initialState], {
    env: { ...process.env, WS_TOKEN: token, O8D_SERVER_VERSION: 'fixture-version' },
  });
  child.stderr?.resume();
  const output = createInterface({ input: child.stdout! });
  const stop = async () => {
    output.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  };
  try {
    const line = await Promise.race([
      once(output, 'line').then(([line]) => String(line)),
      once(child, 'error').then(() => { throw new Error('Rust fixture failed to start'); }),
      once(child, 'exit').then(() => { throw new Error('Rust fixture exited before listening'); }),
    ]);
    const { listening } = JSON.parse(line) as { listening: string };
    return { child, pid: child.pid!, url: `ws://${listening}/ws`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
