/**
 * Uninstall hygiene (#1333): the operator/cortex MCP servers are spawned by
 * EXTERNAL clients (Claude Desktop / Claude Code), not by o8.app — so when the
 * user drags o8 to the Trash, the app can't reap them. The orphan keeps
 * serving from memory (node holds the script after the file is deleted) and
 * resurrects `~/.o8` on its next DB/session touch. To a fresh user, an app
 * that survives its own uninstall and recreates its data dir reads as malware.
 *
 * The precise "the app was deleted" signal is the server's OWN script path
 * disappearing (Trash = the bundle moves out of /Applications, so the bundled
 * `Resources/server/*.mjs` path stops resolving). Poll it cheaply and exit
 * clean when it's gone. Dev runs (tsx from the repo) keep their path and are
 * never affected.
 */

import { existsSync } from 'node:fs';

const ORPHAN_CHECK_INTERVAL_MS = 45_000;

export function exitWhenBundleDeleted(label: string): void {
  const ownPath = process.argv[1];
  if (!ownPath || !existsSync(ownPath)) return; // can't establish a baseline — never arm

  const timer = setInterval(() => {
    if (!existsSync(ownPath)) {
      clearInterval(timer);
      console.error(`[${label}] bundle deleted (${ownPath}) — o8 was uninstalled; exiting so no orphan recreates ~/.o8`);
      process.exit(0);
    }
  }, ORPHAN_CHECK_INTERVAL_MS);
  // Never keep the process alive JUST for this check.
  timer.unref();
}
