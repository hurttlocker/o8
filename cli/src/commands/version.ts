/**
 * `o8 version` — CLI version + connected server version.
 *
 * The CLI version is baked at build time via package.json. The server version
 * is whatever `/api/panel/status` returns (currently always null — the
 * endpoint reports null today, so the CLI surfaces null until the server is
 * extended to include a version string).
 */

import { apiFetch, type CliError } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanKv, printJson, type OutputMode } from '../output.js';

// CLI-PHASE1-TODO: source this from cli/package.json at build time via an
// esbuild --define injection rather than a hard string. Tracked in epic #926.
const CLI_VERSION = '0.0.0-dev';

interface PanelStatus {
  version: string | null;
  nodeVersion?: string;
  platform?: string;
  mode?: string;
  runtime?: string;
}

export async function runVersion(mode: OutputMode): Promise<number> {
  const cfg = resolveConfig();
  let serverVersion: string | null = null;
  let nodeVersion: string | undefined;
  let serverReachable = false;
  try {
    const res = await apiFetch<PanelStatus>(cfg, '/api/panel/status');
    if (res.data) {
      serverVersion = res.data.version ?? null;
      nodeVersion = res.data.nodeVersion;
      serverReachable = true;
    }
  } catch (err) {
    // Don't fail `version` on a missing server — agents call `version` to
    // probe the install before deciding whether to call other commands.
    const code = (err as CliError).code;
    if (code !== 'connection_refused' && code !== 'unauthorized') throw err;
  }

  const payload = {
    schema: 'o8/cli/version/v1',
    cliVersion: CLI_VERSION,
    serverVersion,
    serverReachable,
    nodeVersion: nodeVersion ?? null,
    apiBase: cfg.apiBase,
  };

  if (mode.human) {
    printHumanKv([
      ['cli', CLI_VERSION],
      ['server', serverVersion ?? '(unknown)'],
      ['reachable', serverReachable ? 'yes' : 'no'],
      ['api', cfg.apiBase],
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}
