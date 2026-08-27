import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a TCP port.'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function portIsListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  failure: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(failure());
}

function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

describe('dev stack cleanup real path', () => {
  const run = process.platform === 'win32' ? it.skip : it;

  run('frees both listeners and removes the pid ledger after a terminal Ctrl-C', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-dev-cleanup-'));
    const repoRoot = process.cwd();
    const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
    const tsconfigBefore = readFileSync(tsconfigPath, 'utf8');
    const apiPort = await freePort();
    const wsPort = await freePort();
    const pidFile = path.join(dataDir, 'dev', 'pids.json');
    let output = '';
    const child = spawn(process.execPath, ['scripts/dev.mjs', 'all'], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        O8_DATA_DIR: dataDir,
        PORT: String(apiPort),
        O8_API_PORT: String(apiPort),
        WS_PORT: String(wsPort),
        O8_WS_PORT: String(wsPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-16_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const exited = childExit(child);

    try {
      await waitFor(
        async () => (await portIsListening(apiPort)) && (await portIsListening(wsPort)),
        30_000,
        () => `Dev listeners did not start.\n${output}`,
      );
      expect(JSON.parse(readFileSync(pidFile, 'utf8'))).not.toHaveLength(0);

      process.kill(-child.pid!, 'SIGINT');
      const result = await Promise.race([
        exited,
        delay(15_000).then(() => { throw new Error(`Dev parent did not exit after SIGINT.\n${output}`); }),
      ]);
      expect(result.code === 0 || result.signal === 'SIGINT').toBe(true);
      await waitFor(
        async () => !(await portIsListening(apiPort)) && !(await portIsListening(wsPort)),
        10_000,
        () => `Dev listeners remained bound after SIGINT.\n${output}`,
      );
      expect(existsSync(pidFile)).toBe(false);
      expect(readFileSync(tsconfigPath, 'utf8')).toBe(tsconfigBefore);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
        await exited;
      }
      rmSync(dataDir, { force: true, recursive: true });
    }
  }, 60_000);
});
