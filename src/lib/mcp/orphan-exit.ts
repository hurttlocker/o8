/**
 * Uninstall hygiene (#1333) for MCP servers owned by external clients.
 * A running Node process keeps its loaded code after o8.app is removed, so it
 * must watch the installed app anchor and stop before touching persistent data.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

const ORPHAN_CHECK_INTERVAL_MS = 60_000;

export interface BundledMcpEnvironment {
  O8_BUNDLED_MCP_PATH?: string;
  O8_BUNDLED_MCP_DIR?: string;
}

function appBundleRoot(candidate: string | undefined): string | null {
  const path = candidate?.trim();
  if (!path || !isAbsolute(path)) return null;
  const match = path.match(/^(?:.*[\\/])?o8\.app(?=[\\/]+Contents(?:[\\/]|$))/i);
  return match ? normalize(match[0]) : null;
}

/**
 * Return the installed macOS app root only when a trusted bundled-path signal
 * points inside an exact `o8.app/Contents` tree. Source/dev and lookalike paths
 * deliberately fail open so a checkout can never kill its own MCP process.
 */
export function resolveInstalledAppAnchor(
  scriptPath: string | undefined,
  env: BundledMcpEnvironment,
): string | null {
  const normalizedScriptPath = scriptPath?.trim() ?? '';
  if (/\.tsx?$/i.test(normalizedScriptPath)) return null;
  return appBundleRoot(env.O8_BUNDLED_MCP_PATH)
    ?? appBundleRoot(env.O8_BUNDLED_MCP_DIR)
    ?? appBundleRoot(normalizedScriptPath);
}

export function exitWhenBundleDeleted(
  label: string,
  scriptPath = process.argv[1],
  env: BundledMcpEnvironment = {
    O8_BUNDLED_MCP_PATH: process.env.O8_BUNDLED_MCP_PATH,
    O8_BUNDLED_MCP_DIR: process.env.O8_BUNDLED_MCP_DIR,
  },
): void {
  const anchorPath = resolveInstalledAppAnchor(scriptPath, env);
  if (!anchorPath) return;

  const exitIfMissing = (): boolean => {
    if (existsSync(anchorPath)) return false;
    console.error(`[${label}] installed o8.app is missing at ${anchorPath}; exiting orphaned MCP server`);
    process.exit(0);
    return true;
  };

  if (exitIfMissing()) return;
  const timer = setInterval(() => {
    if (exitIfMissing()) clearInterval(timer);
  }, ORPHAN_CHECK_INTERVAL_MS);
  timer.unref();
}
