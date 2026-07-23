/**
 * Well-known CLI install locations + deep scan + symlink repair.
 *
 * Born from the v0.1.548 beta report (Discord 1523575954709020674): a user with
 * Claude Code and Gemini installed saw "Not installed" in onboarding because
 * detection relied on the child process PATH / a NON-INTERACTIVE login shell
 * (`zsh -l -c`), which sources ~/.zprofile + ~/.zshenv but never ~/.zshrc —
 * and ~/.zshrc is exactly where nvm, fnm, and the Claude native installer
 * (~/.local/bin) add their PATH lines.
 *
 * This module is the deterministic answer: scan the places CLIs actually land,
 * no shell spawn required. Consumers:
 *   - /api/setup/detect (onboarding) — fallback when `which` misses
 *   - cli-resolver strategy 4 (dispatch-time resolution)
 *
 * When a binary is found OUTSIDE the process PATH we "make a match": symlink it
 * into ~/.o8/bin (which the Tauri sidecar puts on every child's PATH), so plain
 * `which`/PTY terminals/worker spawns find it from then on.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Scan a version-manager root (nvm/fnm layout: <root>/<version>/...) and
 * return the per-version bin dirs, newest version first, so a freshly
 * installed Node 24's global bin wins over a stale Node 18's.
 */
function versionManagerBinDirs(root: string, binSubpath: string[]): string[] {
  try {
    const entries = readdirSync(root);
    return entries
      .sort((a, b) => {
        // Descending semver-ish sort: v24.1.0 before v22.11.0. Non-numeric
        // segments compare as 0 — good enough for version dir names.
        const pa = a.replace(/^v/, '').split('.').map((s) => Number.parseInt(s, 10) || 0);
        const pb = b.replace(/^v/, '').split('.').map((s) => Number.parseInt(s, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
          const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return 0;
      })
      .map((v) => path.join(root, v, ...binSubpath))
      .filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

/**
 * Every directory a runtime CLI (claude / codex / gemini / opencode / gh) is
 * known to land in, ordered by how often each install method is the culprit
 * when PATH-based lookup misses. All entries are filtered to dirs that exist.
 *
 * `home` is injectable for tests.
 */
export function wellKnownCliDirs(home: string = os.homedir()): string[] {
  const staticDirs = [
    path.join(home, '.o8', 'bin'), // our own symlink farm — repaired links win
    path.join(home, '.local', 'bin'), // Claude Code NATIVE installer default
    path.join(home, '.claude', 'local'), // claude migrate-installer target
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, 'Library', 'pnpm'), // pnpm global bin (macOS)
    path.join(home, '.local', 'share', 'pnpm'), // pnpm global bin (XDG)
    path.join(home, '.deno', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.fnm', 'aliases', 'default', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  const nvmDirs = versionManagerBinDirs(path.join(home, '.nvm', 'versions', 'node'), ['bin']);
  const fnmDirs = versionManagerBinDirs(path.join(home, '.fnm', 'node-versions'), ['installation', 'bin']);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...staticDirs, ...nvmDirs, ...fnmDirs]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (existsSync(dir)) out.push(dir);
  }
  return out;
}

/**
 * Deterministic filesystem scan for a binary across every well-known CLI dir.
 * Returns the absolute path of the first hit, or null. No shell is spawned —
 * this works identically under Finder-stripped PATH, dev servers, and tests.
 */
export function scanForBinary(binaryName: string, home: string = os.homedir()): string | null {
  for (const dir of wellKnownCliDirs(home)) {
    const candidate = path.join(dir, binaryName);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // unreadable dir — keep scanning
    }
  }
  return null;
}

/**
 * "Make a match": link a scan-found binary into ~/.o8/bin/<name> so PATH-based
 * consumers (which, PTY terminals, worker spawns) find it from now on. The
 * sidecar puts ~/.o8/bin on every child's PATH.
 *
 * Safe by construction: only ever (re)writes SYMLINKS inside ~/.o8/bin — an
 * existing real file there is left alone. Returns the symlink path when the
 * link exists and points at target, else null. Best-effort: callers treat null
 * as "scan path still works, just not via PATH".
 */
export function ensureCliSymlink(
  binaryName: string,
  targetPath: string,
  home: string = os.homedir(),
): string | null {
  try {
    const binDir = path.join(home, '.o8', 'bin');
    mkdirSync(binDir, { recursive: true });
    const linkPath = path.join(binDir, binaryName);
    // Never link a farm entry to itself (scan can hand us ~/.o8/bin/<name>).
    if (path.resolve(targetPath) === path.resolve(linkPath)) return linkPath;
    try {
      const st = lstatSync(linkPath);
      if (!st.isSymbolicLink()) return null; // real file — hands off
      if (readlinkSync(linkPath) === targetPath) return linkPath; // already correct
      unlinkSync(linkPath); // stale link (old install path) — re-point
    } catch {
      // lstat failed → nothing at linkPath, fall through to create
    }
    symlinkSync(targetPath, linkPath);
    console.log(`[cli-locate] Linked ${binaryName} -> ${targetPath} in ~/.o8/bin`);
    return linkPath;
  } catch (err) {
    console.warn(`[cli-locate] Could not symlink ${binaryName} into ~/.o8/bin:`, err);
    return null;
  }
}

/**
 * Convenience for detection surfaces: scan, and when found, repair the PATH
 * story via the symlink farm. Returns the ORIGINAL absolute path (display +
 * version probing should show where the real install lives).
 */
export function scanAndLink(binaryName: string, home: string = os.homedir()): string | null {
  const found = scanForBinary(binaryName, home);
  if (!found) return null;
  ensureCliSymlink(binaryName, found, home);
  return found;
}

/**
 * Spawn-time resolver for the `claude` binary — env override, then a cached
 * scan hit that is RE-VALIDATED on every call.
 *
 * The validation is the point (F6JHXW, Sydney 2026-07-16): Claude Code's
 * native auto-updater repoints ~/.local/bin/claude at
 * ~/.local/share/claude/versions/<new> BEFORE the new binary finishes
 * downloading, so for a multi-minute window the whole symlink chain is dead
 * and every spawn ENOENTs. A forever-cache (the old _claudeBinCache in
 * orchestrator-session) stayed stuck on the dead chain even when a healthy
 * sibling install (nvm/brew) was one re-scan away. existsSync follows the
 * FULL symlink chain, so a mid-update break fails the check and the very
 * next call re-scans — one stat per spawn when healthy.
 */
let cachedClaudeBin: string | null = null;
export function resolveClaudeBinary(home: string = os.homedir()): string {
  const envOverride = process.env.O8_CLAUDE_CODE_BIN || process.env.CLAUDE_BIN;
  if (envOverride) {
    if (existsSync(envOverride)) return envOverride;
    throw new Error(
      `[runtime] Claude Code is not installed at ${envOverride}. `
      + 'Install Claude Code, or update O8_CLAUDE_CODE_BIN/CLAUDE_BIN to its executable path.',
    );
  }
  if (cachedClaudeBin && existsSync(cachedClaudeBin)) return cachedClaudeBin;
  cachedClaudeBin = scanForBinary('claude', home);
  if (!cachedClaudeBin) {
    throw new Error(
      '[runtime] Claude Code is not installed. Install it, run `claude` once to sign in, then retry.',
    );
  }
  return cachedClaudeBin;
}
