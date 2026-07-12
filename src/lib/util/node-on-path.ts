import path from 'node:path';

/**
 * PATH with the running server's OWN node runtime guaranteed present.
 *
 * Every runtime CLI o8 spawns (codex, claude, cursor-agent — the shims in
 * ~/.o8/bin) is a `#!/usr/bin/env node` script. On a machine where node is
 * managed per-shell (nvm sourced in .zshrc — interactive only), the server's
 * inherited PATH has NO node at all, so every child died with
 * `env: node: No such file or directory` and every launch failed with a bare
 * "exited with code 1" (#1551 follow-up, live-hit 2026-07-12: nvm-only
 * laptop — codex AND claude unlaunchable; the iMac only worked because a
 * global /usr/local/bin/node happened to exist).
 *
 * The fix needs no shell archaeology: this server IS node — process.execPath
 * is a working node binary on every machine, by definition. Prepend its
 * directory (idempotent) so `#!/usr/bin/env node` always resolves.
 */
export function pathWithNodeRuntime(basePath?: string): string {
  const nodeDir = path.dirname(process.execPath);
  const base = basePath ?? process.env.PATH ?? '';
  const parts = base.split(path.delimiter).filter(Boolean);
  if (parts.includes(nodeDir)) return base;
  return [nodeDir, ...parts].join(path.delimiter);
}
