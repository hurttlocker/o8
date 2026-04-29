/**
 * Resolve the codebase-memory-mcp binary path.
 *
 * Mirrors the resolution rules used by the Claude Desktop / Claude Code
 * config generator (src/app/api/setup/mcp-config/route.ts):
 *   1. process.env.O8_CODEBASE_MEMORY_BIN — set by the Tauri sidecar after
 *      the cached binary is verified, OR after a fresh download finishes.
 *   2. ~/.o8/bin/codebase-memory-mcp (.exe on Windows) — the deterministic
 *      install location used by #739. We fall back to it because the env
 *      var only inherits to children spawned AFTER the download completes,
 *      which the Node sidecar usually isn't.
 *
 * Returns null when neither resolves to a real file. Callers MUST treat
 * null as "feature unavailable" so cold first launch (binary still
 * downloading) doesn't break the boot indexer.
 */

import 'server-only';

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const POLL_INTERVAL_MS = 1500;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

export function resolveCodebaseMemoryBin(): string | null {
  const fromEnv = process.env.O8_CODEBASE_MEMORY_BIN;
  if (fromEnv && fromEnv.trim() && existsSync(fromEnv)) {
    return fromEnv;
  }

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  if (!home) return null;

  const fileName =
    process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';
  const deterministic = join(home, '.o8', 'bin', fileName);
  if (existsSync(deterministic)) {
    return deterministic;
  }

  return null;
}

/**
 * Poll for the binary up to `timeoutMs`. Resolves with the path when found,
 * or null if it never appears.
 *
 * The Tauri sidecar emits `codebase-memory:status` to the webview but we
 * can't subscribe to that from server-side Node. Polling for the
 * deterministic file path is equivalent and avoids any cross-process
 * coordination.
 */
export async function waitForCodebaseMemoryBin(
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bin = resolveCodebaseMemoryBin();
    if (bin) return bin;
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return resolveCodebaseMemoryBin();
}
