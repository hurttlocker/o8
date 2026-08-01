import 'server-only';

/**
 * Lexical and canonical path helpers for display, allowlist selection, and
 * directory resolution. They do NOT make a later path-based file open safe.
 * File-content callers must use `workspace-file.ts`, which opens first and
 * validates the descriptor it will keep using.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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

function existsIncludingBrokenSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve a repository-relative path for display or directory-only operations.
 * This result MUST NOT be opened later for file contents: a symlink swap can
 * invalidate the check before the open. Use `openWorkspaceFile` instead.
 */
export function safeJoinReal(
  root: string,
  relPath: string,
  options: { allowMissing?: boolean } = {},
): string | null {
  const lexical = safeJoin(root, relPath);
  if (!lexical) return null;

  let realRoot: string;
  try {
    realRoot = realpathSync.native(resolve(root));
  } catch {
    return null;
  }

  if (existsIncludingBrokenSymlink(lexical)) {
    try {
      const realTarget = realpathSync.native(lexical);
      return isWithin(realRoot, realTarget) ? lexical : null;
    } catch {
      return null;
    }
  }

  if (!options.allowMissing) return null;

  let ancestor = dirname(lexical);
  while (!existsIncludingBrokenSymlink(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }

  try {
    const realAncestor = realpathSync.native(ancestor);
    return isWithin(realRoot, realAncestor) ? lexical : null;
  } catch {
    return null;
  }
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
