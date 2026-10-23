import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

export const root = path.resolve(import.meta.dirname, '../..');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const round = n => Number(n.toFixed(2));
export function evidencePath(value) {
  const file = path.resolve(value);
  if (!file.startsWith(root + path.sep)) throw new Error('Evidence must stay inside this worktree');
  let ancestor = file;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonical = fs.realpathSync(ancestor);
  if (canonical !== root && !canonical.startsWith(root + path.sep)) throw new Error('Evidence must not follow an external symlink');
  return file;
}
export function distribution(values) {
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid sample');
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n, samples: values, median: n ? round((sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2) : null,
    p95: n ? round(sorted[Math.ceil(n * .95) - 1]) : null, worst: n ? round(sorted[n - 1]) : null,
  };
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export function isReservedPort(port) {
  return [...fs.readFileSync(path.join(root, 'src/lib/panel/port-constants.ts'), 'utf8').matchAll(/\b\d{5}\b/g)].some(match => Number(match[0]) === port);
}
export async function freePort() {
  const reserved = new Set([...fs.readFileSync(path.join(root, 'src/lib/panel/port-constants.ts'), 'utf8').matchAll(/\b\d{5}\b/g)].map(m => Number(m[0])));
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
    if (!reserved.has(port)) return port;
  }
}
export function launch(args, env, logPath, command = process.execPath, cwd = root) {
  const fd = fs.openSync(logPath, 'a', 0o600);
  const started = performance.now();
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  child.on('error', error => { child.launchError = error.message; });
  return { child, started, logPath };
}
export async function stop(owned) {
  if (!owned?.child.pid) return;
  try { process.kill(-owned.child.pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 30 && owned.child.exitCode === null && owned.child.signalCode === null; i++) await sleep(100);
  // Descendants can outlive their group leader. The group was created by us.
  try { process.kill(-owned.child.pid, 'SIGKILL'); } catch { /* group exited */ }
}
export async function healthy(url, owned, token, timeoutMs = 180000) {
  while (performance.now() - owned.started < timeoutMs) {
    if (owned.child.launchError || owned.child.exitCode !== null || owned.child.signalCode !== null) throw new Error(`Owned server exited: ${owned.child.launchError ?? owned.child.exitCode}`);
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
      if (response.ok) { await response.arrayBuffer(); return round(performance.now() - owned.started); }
    } catch { /* starting */ }
    await sleep(50);
  }
  throw new Error('Health deadline exceeded');
}
export function rss(roots) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return match ? { pid: +match[1], ppid: +match[2], rssMiB: round(+match[3] / 1024), cpuTime: match[4], command: match[5] } : null;
  }).filter(Boolean);
  const result = {};
  for (const [label, pid] of Object.entries(roots)) {
    const pids = new Set([pid]);
    for (let i = 0; i < rows.length; i++) for (const row of rows) if (pids.has(row.ppid)) pids.add(row.pid);
    result[label] = rows.filter(row => pids.has(row.pid)).map(({ command, ...row }) => ({ ...row, process: command.includes('next-server') ? 'next-server' : path.basename(command) }));
  }
  return result;
}
