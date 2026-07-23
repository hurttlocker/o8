import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export interface McpSetupReadiness {
  ready: boolean;
  reason: string | null;
  detail: string | null;
  /** Non-blocking degradation note — setup PROCEEDS, but a nice-to-have
   *  component is missing (rendered as a calm note, never a [WAIT] block). */
  warning: string | null;
}

/** A "downloading" claim older than this is a lie — the downloader either
 *  crashed or the process died mid-fetch. Treat as unavailable, not pending. */
const DOWNLOADING_STALE_MS = 10 * 60 * 1000;

/**
 * Read the Rust downloader's lifecycle file (written by
 * `write_codebase_memory_status` in src-tauri/src/lib.rs). Returns
 * 'downloading' | 'ready' | 'error' | null (no signal yet / pre-status builds).
 */
function readCodebaseMemoryStatus(dataDir: string): 'downloading' | 'ready' | 'error' | null {
  try {
    const path = join(dataDir, 'bin', '.codebase-memory-status');
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8').trim();
    if (raw === 'downloading') {
      const age = Date.now() - statSync(path).mtimeMs;
      return age > DOWNLOADING_STALE_MS ? 'error' : 'downloading';
    }
    if (raw === 'ready' || raw === 'error') return raw;
    return null;
  } catch {
    return null;
  }
}

const CODEBASE_MEMORY_UNAVAILABLE_WARNING =
  'codebase-memory could not be downloaded, so Connect proceeds without it — '
  + 'code search depth is reduced until it installs. o8 retries at every launch.';

export function getMcpSetupReadiness(): McpSetupReadiness {
  const packaged = process.env.O8_PACKAGED_APP === '1';
  const bundledPath = process.env.O8_BUNDLED_MCP_PATH;
  if (!packaged) {
    return { ready: true, reason: null, detail: null, warning: null };
  }
  if (!bundledPath || !existsSync(bundledPath)) {
    return {
      ready: false,
      reason: 'bundled_mcp_not_ready',
      detail: 'o8 is still finishing first launch. Wait for startup to finish, then run Connect again.',
      warning: null,
    };
  }

  const dataDir = getDataDir();
  const codebaseMemoryBin = process.env.O8_CODEBASE_MEMORY_BIN
    || join(dataDir, 'bin', process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp');
  if (existsSync(codebaseMemoryBin)) {
    return { ready: true, reason: null, detail: null, warning: null };
  }

  // Binary absent. codebase-memory is OPTIONAL — the connect routes and the
  // tool-spine registry already omit its entry when the binary is missing —
  // so absence must only block while a download is genuinely in flight.
  // Blocking on it forever was the 2026-07-09 beta bug: upstream deleted the
  // pinned release's assets, every fresh install's download 404'd on every
  // launch, and this gate showed "still downloading… wait" for DAYS with the
  // Connect buttons disabled. Unknown-status note: the env sentinel
  // O8_CODEBASE_MEMORY_BIN === '' is the Rust side's explicit "failed /
  // unavailable" signal; the status file distinguishes in-flight from failed.
  const status = readCodebaseMemoryStatus(dataDir);
  const explicitlyUnavailable = process.env.O8_CODEBASE_MEMORY_BIN === '' || status === 'error';
  if (explicitlyUnavailable || status === null) {
    // No in-flight download (or no signal at all → the downloader thread
    // writes 'downloading' within seconds of boot, so a persistent null is a
    // pre-status build or a crashed thread): unblock with an honest note.
    return {
      ready: true,
      reason: null,
      detail: null,
      warning: CODEBASE_MEMORY_UNAVAILABLE_WARNING,
    };
  }

  return {
    ready: false,
    reason: 'codebase_memory_not_ready',
    detail: 'o8 is still downloading codebase-memory for first launch. Wait for startup to finish, then run Connect again.',
    warning: null,
  };
}
