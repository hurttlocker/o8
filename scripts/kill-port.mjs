#!/usr/bin/env node
/**
 * Free the given TCP ports by killing whatever is listening on them (#1744).
 * Replaces `lsof -ti :<port> -sTCP:LISTEN | xargs kill -9 2>/dev/null; ...`,
 * which needs both a POSIX shell and Unix networking tools.
 *
 *   node scripts/kill-port.mjs 3010 3011
 *
 * Best-effort by design, matching the trailing `; true` of the shell version:
 * nothing here is fatal and the exit code is always 0.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * PIDs listening on `port`, parsed out of `lsof -ti :<port> -sTCP:LISTEN`
 * (one PID per line).
 */
export function parseLsofPids(stdout) {
  return [...new Set(
    String(stdout)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map(Number),
  )];
}

/**
 * PIDs listening on `port`, parsed out of `netstat -ano -p tcp`.
 *
 * Matching on the foreign address (`0.0.0.0:0` / `[::]:0`) rather than the
 * state column on purpose: the state word is localized on non-English Windows
 * ("ABHOEREN", "ESCUCHANDO"), the address shape is not.
 */
export function parseNetstatPids(stdout, port) {
  const suffix = `:${port}`;
  const pids = new Set();
  for (const line of String(stdout).split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    const [proto, local, foreign] = columns;
    if (!/^tcp$/i.test(proto)) continue;
    if (!local.endsWith(suffix)) continue;
    if (foreign !== '0.0.0.0:0' && foreign !== '[::]:0') continue;
    const pid = columns[columns.length - 1];
    if (/^\d+$/.test(pid) && Number(pid) > 0) pids.add(Number(pid));
  }
  return [...pids];
}

function listeningPids(port) {
  if (process.platform === 'win32') {
    const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    return result.status === 0 ? parseNetstatPids(result.stdout ?? '', port) : [];
  }
  const result = spawnSync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  // lsof exits 1 when nothing matches — that is the empty case, not an error.
  return parseLsofPids(result.stdout ?? '');
}

function kill(pid) {
  if (process.platform === 'win32') {
    // No SIGKILL on Windows; taskkill /T /F takes the whole process tree, the
    // same call the Rust sidecar reaper uses (#1739).
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

function main(ports) {
  for (const raw of ports) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0) continue;
    for (const pid of listeningPids(port)) {
      if (pid === process.pid) continue;
      kill(pid);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
