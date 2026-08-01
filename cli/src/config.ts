/**
 * Port + token resolution for the o8 CLI.
 *
 * Standalone (no @/lib imports) so the bundle stays self-contained. Mirrors
 * the resolution order used by src/lib/panel/api-port.ts so worker agents
 * spawned by o8 (which already have O8_API_PORT / O8_API_TOKEN in their env)
 * skip the disk read entirely.
 *
 * Resolution order:
 *   1. env (O8_API_PORT, O8_API_TOKEN — set by dispatch)
 *   2. ~/.o8/{api-port,ws-token} (new data dir)
 *   3. ~/.cortex-ide/{api-port,ws-token} (legacy data dir)
 *   4. fallback port 3001, no token (dev workflow on loopback)
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

export interface ResolvedConfig {
  apiPort: number;
  apiBase: string;
  token: string | null;
  workerPacketId: string | null;
  source: {
    port: 'env' | 'o8-dir' | 'cortex-ide-dir' | 'default';
    token: 'worker' | 'env' | 'o8-dir' | 'cortex-ide-dir' | 'none';
  };
  dataDir: string | null;
}

const O8_DIR = () => join(homedir(), '.o8');
const LEGACY_DIR = () => join(homedir(), '.cortex-ide');

function readPortFile(dir: string): number | null {
  const p = join(dir, 'api-port');
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  } catch {
    return null;
  }
}

function readTokenFile(dir: string): string | null {
  const p = join(dir, 'ws-token');
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function detectPacketIdFromCwd(cwd: string): string | null {
  const parts = cwd.split(sep);
  for (let i = parts.length - 1; i >= 1; i--) {
    const prev = parts[i - 1];
    const cur = parts[i];
    if (!cur?.startsWith('packet-')) continue;
    if (prev === '.cortex-worktrees' || (prev === 'worktrees' && parts[i - 2] === '.claude')) {
      const packetId = cur.slice('packet-'.length).trim();
      return packetId || null;
    }
  }
  return null;
}

export function resolveConfig(): ResolvedConfig {
  const envPort = process.env.O8_API_PORT && Number.parseInt(process.env.O8_API_PORT, 10);
  // A dispatched worker carries O8_WORKER_TOKEN (stamped at spawn). Sending it as
  // the Bearer lets governance routes identify the caller as a worker and deny
  // worker-forbidden actions (e.g. resolving its own approval). Prefer it over
  // the shared ws-token so a worker never presents the operator credential.
  // (docs/internals/security-audit-2026-07-02.md §CRIT-1.) A human running `o8` manually has no
  // O8_WORKER_TOKEN, so they fall through to the ws-token and act as operator.
  const workerToken = process.env.O8_WORKER_TOKEN?.trim() || null;
  const workerPacketId = workerToken
    ? process.env.O8_WORKER_PACKET_ID?.trim() || detectPacketIdFromCwd(process.cwd())
    : null;
  const envToken = process.env.O8_API_TOKEN?.trim() || null;

  let apiPort: number | null = null;
  let portSource: ResolvedConfig['source']['port'] = 'default';
  let dataDir: string | null = null;

  if (envPort && Number.isInteger(envPort) && envPort > 0 && envPort < 65536) {
    apiPort = envPort;
    portSource = 'env';
  } else {
    const o8 = readPortFile(O8_DIR());
    if (o8) {
      apiPort = o8;
      portSource = 'o8-dir';
      dataDir = O8_DIR();
    } else {
      const legacy = readPortFile(LEGACY_DIR());
      if (legacy) {
        apiPort = legacy;
        portSource = 'cortex-ide-dir';
        dataDir = LEGACY_DIR();
      }
    }
  }
  if (!apiPort) apiPort = 3001;

  let token: string | null = null;
  let tokenSource: ResolvedConfig['source']['token'] = 'none';
  if (workerToken) {
    token = workerToken;
    tokenSource = 'worker';
  } else if (envToken) {
    token = envToken;
    tokenSource = 'env';
  } else {
    const o8 = readTokenFile(O8_DIR());
    if (o8) {
      token = o8;
      tokenSource = 'o8-dir';
      if (!dataDir) dataDir = O8_DIR();
    } else {
      const legacy = readTokenFile(LEGACY_DIR());
      if (legacy) {
        token = legacy;
        tokenSource = 'cortex-ide-dir';
        if (!dataDir) dataDir = LEGACY_DIR();
      }
    }
  }

  return {
    apiPort,
    apiBase: `http://127.0.0.1:${apiPort}`,
    token,
    workerPacketId,
    source: { port: portSource, token: tokenSource },
    dataDir,
  };
}
