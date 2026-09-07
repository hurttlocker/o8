import { existsSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// An attempted load owns persistent work even if its caller throws before it
// can return a receipt. Only an explicit, complete empty teardown permits removal.
export function loadTeardownProvesClean(loadScenario) {
  const teardown = loadScenario?.teardown;
  const counts = teardown?.residuals?.counts;
  return teardown?.refused === 0
    && ['lanes', 'childProcesses', 'worktrees', 'listeners'].every((key) => counts?.[key] === 0)
    && Object.values(counts).every((count) => count === 0);
}

function listenerGone(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

async function killProcessGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await sleep(3000);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

export async function cleanupGate({ client, child, dataDir, socketPath, preserveDataDir = false }) {
  client?.dispose();
  await killProcessGroup(child);
  const apiPortPath = dataDir ? path.join(dataDir, 'api-port') : null;
  const apiPort = apiPortPath && existsSync(apiPortPath) ? Number(readFileSync(apiPortPath, 'utf8')) : null;
  rmSync(socketPath, { force: true });
  rmSync(`${socketPath}.token`, { force: true });
  // Verify shutdown before removing anything that a surviving server may own.
  if (apiPort && !(await listenerGone(apiPort))) {
    throw new Error(`child API port still has a listener after cleanup; profile preserved: ${dataDir}`);
  }
  if (dataDir && !preserveDataDir) rmSync(dataDir, { recursive: true, force: true });
  if (dataDir && preserveDataDir) {
    console.error(`[preship-webview-gate] preserved isolated profile for inspection: ${dataDir}`);
  }
}
