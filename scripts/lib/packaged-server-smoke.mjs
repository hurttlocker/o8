import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertTauriExportInputsSafe } from './tauri-export-safety.mjs';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function stopChild(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch { /* already exited */ }
}

export async function smokePackagedServer(serverRoot, options = {}) {
  if (!existsSync(join(serverRoot, 'server.js'))) throw new Error('packaged server.js is missing');
  assertTauriExportInputsSafe(serverRoot);
  const profile = mkdtempSync(join(tmpdir(), 'o8-packaged-server-smoke-'));
  const port = await unusedPort();
  let wsPort = await unusedPort();
  while (wsPort === port) wsPort = await unusedPort();
  const bootId = randomUUID();
  const env = {
    ...process.env,
    O8_DATA_DIR: profile,
    CORTEX_IDE_DATA_DIR: profile,
    PORT: String(port),
    O8_API_PORT: String(port),
    O8_WS_PORT: String(wsPort),
    HOSTNAME: '127.0.0.1',
    O8_PACKAGED_APP: '1',
    O8_BOOT_ID: bootId,
  };
  delete env.NODE_OPTIONS;
  delete env.O8_TAURI_MCP_SOCKET;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: serverRoot,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exitCode = null;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.on('exit', (code, signal) => { exitCode = code ?? signal ?? 'unknown'; });
  child.on('error', (error) => {
    output += `\n${error.message}`;
    exitCode = 'spawn error';
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { output = `${output}${chunk.toString()}`.slice(-6000); });
  }

  try {
    const deadline = Date.now() + (options.timeoutMs ?? 45_000);
    while (Date.now() < deadline) {
      if (exitCode !== null) throw new Error(`packaged server exited (${exitCode}): ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/setup/identity`, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) {
          const identity = await response.json();
          if (identity.product === 'o8' && identity.apiPort === port && identity.bootId === bootId) {
            return { port, version: identity.version };
          }
        }
      } catch { /* server still starting */ }
      await delay(200);
    }
    throw new Error(`packaged server did not serve its identity within the deadline: ${output}`);
  } finally {
    stopChild(child);
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* already exited */ }
    }
    rmSync(profile, { recursive: true, force: true });
  }
}
