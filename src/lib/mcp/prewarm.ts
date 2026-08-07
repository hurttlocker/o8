/**
 * Background prewarm for npx-family MCP servers.
 *
 * When a user registers a server whose command is `npx` (or any other
 * lazy-fetch runner), we immediately fire a background spawn of
 * `<command> <pkg> --help` (or `--version` as a fallback) so the npm cache
 * is warm before the first "Test Connection" click.
 *
 * Contract:
 *  - Returns a Promise<void> that ALWAYS resolves — never rejects.
 *  - Process stdout/stderr are discarded.
 *  - Hard-killed after 60 s to prevent orphans.
 *  - Failures are silently swallowed; at most one short `[mcp-prewarm]` log
 *    line is printed on unexpected spawn errors so we don't pollute logs.
 */

import { spawn } from 'node:child_process';
import { isNpxFamily } from './npx-detection';

const PREWARM_TIMEOUT_MS = 60_000;

export interface PrewarmInput {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export async function prewarmMcpServer(input: PrewarmInput): Promise<void> {
  if (!isNpxFamily(input.command)) return;

  // Build a minimal argv that just fetches / confirms the package exists.
  // For npx/bunx the args array already contains the package name as the first
  // element (e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]).
  // We re-use those args verbatim — npm will cache the package and exit quickly.
  const argv = [...(input.args ?? [])];
  if (argv.length === 0) return; // nothing to prewarm without a package name

  return new Promise<void>((resolve) => {
    let child: ReturnType<typeof spawn> | null = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (child) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          if (child && !child.killed) {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }, 500);
      }
      resolve();
    };

    const killer = setTimeout(finish, PREWARM_TIMEOUT_MS);

    try {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(input.env ?? {}) };
      child = spawn(input.command, argv, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: childEnv,
      });
    } catch (spawnErr) {
      clearTimeout(killer);
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      console.log(`[mcp-prewarm] spawn error (ignored): ${msg}`);
      resolve();
      return;
    }

    child.on('error', () => {
      clearTimeout(killer);
      finish();
    });

    child.on('exit', () => {
      clearTimeout(killer);
      finish();
    });
  });
}
