/**
 * Shared port resolver — answers "where is the o8 backend?"
 *
 * Resolution order (first match wins):
 *   1. Explicit env var: PORT, O8_API_PORT, CORTEX_IDE_PORT.
 *   2. `~/.cortex-ide/api-port` written by the Tauri Rust sidecar during
 *      startup (probe-from-3001-upward). Stale files are tolerated because
 *      the env var path wins when present.
 *   3. Legacy default 3001 so dev workflows (`npm run dev`) still work.
 *
 * This is the single source of truth for /api/setup/mcp-config,
 * /api/setup/claude-desktop, orchestrator-session.ts, and the MCP server.
 * Never hardcode 3001 in a new file — import from here.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PortInfo {
  apiPort: number;
  wsPort: number;
  source: 'env' | 'file' | 'default';
}

// Small cache — re-read the port file if it's been rewritten (e.g., the
// Tauri shell restarted into a new port).
let _cached: { info: PortInfo; mtimeMs: number } | null = null;

function dataDir(): string {
  return process.env.CORTEX_IDE_DATA_DIR
    || join(process.env.HOME || '', '.cortex-ide');
}

function readPortFile(name: string): number | null {
  const p = join(dataDir(), name);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8').trim();
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    return null;
  } catch {
    return null;
  }
}

function portFileMtime(name: string): number | null {
  try {
    const p = join(dataDir(), name);
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

export function resolvePortInfo(): PortInfo {
  // 1) Env var wins. `PORT` comes from the Next.js process itself (bundled
  // server.js sets it). `O8_API_PORT` is set explicitly by the Rust sidecar
  // for child processes.
  const apiFromEnv =
    (process.env.O8_API_PORT && parseInt(process.env.O8_API_PORT, 10))
    || (process.env.PORT && parseInt(process.env.PORT, 10))
    || (process.env.CORTEX_IDE_PORT && parseInt(process.env.CORTEX_IDE_PORT, 10))
    || null;
  const wsFromEnv =
    (process.env.O8_WS_PORT && parseInt(process.env.O8_WS_PORT, 10))
    || (process.env.WS_PORT && parseInt(process.env.WS_PORT, 10))
    || null;

  if (apiFromEnv && Number.isFinite(apiFromEnv)) {
    return {
      apiPort: apiFromEnv,
      wsPort: wsFromEnv && Number.isFinite(wsFromEnv) ? wsFromEnv : 3002,
      source: 'env',
    };
  }

  // 2) Port file — cached by mtime.
  const apiMtime = portFileMtime('api-port');
  if (apiMtime != null && _cached && _cached.mtimeMs === apiMtime) {
    return _cached.info;
  }
  const apiFromFile = readPortFile('api-port');
  const wsFromFile = readPortFile('ws-port');
  if (apiFromFile) {
    const info: PortInfo = {
      apiPort: apiFromFile,
      wsPort: wsFromFile ?? 3002,
      source: 'file',
    };
    if (apiMtime != null) _cached = { info, mtimeMs: apiMtime };
    return info;
  }

  // 3) Default fallback — dev workflow.
  return { apiPort: 3001, wsPort: 3002, source: 'default' };
}

export function getApiBase(): string {
  const { apiPort } = resolvePortInfo();
  return `http://127.0.0.1:${apiPort}`;
}

export function getWsBase(): string {
  const { wsPort } = resolvePortInfo();
  return `ws://127.0.0.1:${wsPort}`;
}
