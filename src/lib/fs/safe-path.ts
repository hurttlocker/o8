import 'server-only';

/**
 * Path-safety helpers — the single implementation of "does this path escape its
 * root" for every file-serving API route. Hand-rolled `fullPath.startsWith(root)`
 * checks are unsafe (they trust a caller-supplied root and miss `..` traversal);
 * routes must use these instead. See SECURITY_REMEDIATION_PLAN_2026-07-02.md RF-4.
 */

import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Expand a leading `~` / `~/` to the current user's home directory. */
export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return input;
}

/**
 * Resolve `relPath` under `root` and return the absolute path ONLY if it stays
 * inside `root` (after normalization). Returns null on any escape — including an
 * absolute `relPath` that points outside `root`, or `..` traversal.
 *
 * Mirrors the correct pattern already used in api/panel/file-asset: resolve →
 * relative → reject `..`/absolute. Empty relative (the root itself) is allowed.
 */
export function safeJoin(root: string, relPath: string): string | null {
  const base = resolve(root);
  const resolved = resolve(base, relPath);
  const rel = relative(base, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolved;
}

/**
 * Confine an absolute-or-`~` `candidate` to one of `roots` (normalized). Returns
 * the resolved absolute path if it equals or sits strictly inside any allowed
 * root, else null. Use for routes with a fixed allow-list of roots (e.g. serving
 * images from HOME/tmp) — normalizes first, so `~/../../etc/x` cannot slip past a
 * `startsWith` check.
 */
export function confineToRoots(candidate: string, roots: string[]): string | null {
  const resolved = resolve(expandHome(candidate));
  for (const root of roots) {
    const base = resolve(root);
    if (resolved === base || resolved.startsWith(base + sep)) return resolved;
  }
  return null;
}
