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

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataDir } from '../../data-dir-migration';

function dataDirForHome(home: string): string {
  return home === os.homedir() ? getDataDir() : getDataDir({}, home);
}

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
 * Windows install targets. None of the POSIX entries above exist on Windows,
 * so before this list a Windows box could not resolve a single runtime CLI —
 * `npm i -g` lands in %APPDATA%\npm, which was absent, and every runtime
 * resolves through this same scan. The result was that mission creation
 * refused every runtime as "not installed" and dispatch was impossible.
 *
 * Kept out of the main array (rather than inlined) because these read from
 * environment variables that are empty off Windows, which would otherwise
 * produce junk relative paths on macOS and Linux.
 */
function windowsCliDirs(home: string): string[] {
  if (process.platform !== 'win32') return [];
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  return [
    path.join(appData, 'npm'), // npm -g — by far the most common
    path.join(localAppData, 'pnpm'),
    path.join(localAppData, 'Volta', 'bin'),
    path.join(localAppData, 'Microsoft', 'WindowsApps'), // winget shims
    path.join(home, 'scoop', 'shims'),
    path.join(programData, 'chocolatey', 'bin'),
    path.join(programFiles, 'nodejs'),
  ];
}

/**
 * Executable suffixes to try for a given binary name, in resolution order.
 *
 * Windows only marks a file executable by EXTENSION, and npm drops TWO files
 * per global bin: an extensionless shell script (for Git Bash) and a `.cmd`
 * shim (for cmd/PowerShell). Probing the bare name first would find the shell
 * script — which Windows cannot execute — and hand a spawn-time failure back
 * as if the CLI were healthy. So real executable extensions win, and the bare
 * name stays last as a fallback.
 */
export function executableSuffixes(): string[] {
  if (process.platform !== 'win32') return [''];
  const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.'));
  return [...new Set([...pathext, ''])];
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
    path.join(dataDirForHome(home), 'bin'), // our own symlink farm — repaired links win
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
    ...windowsCliDirs(home),
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
  const suffixes = executableSuffixes();
  for (const dir of wellKnownCliDirs(home)) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${binaryName}${suffix}`);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // unreadable dir — keep scanning
      }
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
  if (process.platform === 'win32') return ensureCliShimCmd(binaryName, targetPath, home);
  try {
    const binDir = path.join(dataDirForHome(home), 'bin');
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
 * Windows equivalent of the symlink farm entry.
 *
 * `symlinkSync` needs Developer Mode or an elevated process on Windows, so for
 * an ordinary user it throws EPERM and the farm never populates — the "make a
 * match" repair was silently dead on Windows. A forwarding `.cmd` needs no
 * privileges and is what PATH-based consumers (cmd, PowerShell, PTY terminals)
 * actually resolve anyway.
 *
 * Same never-clobber guarantee as the symlink path: we only ever overwrite a
 * file carrying our own marker line, so a real executable a user dropped in
 * the farm is left alone.
 */
const SHIM_MARKER = '@rem o8-cli-shim';

function ensureCliShimCmd(
  binaryName: string,
  targetPath: string,
  home: string = os.homedir(),
): string | null {
  try {
    const binDir = path.join(dataDirForHome(home), 'bin');
    mkdirSync(binDir, { recursive: true });
    const shimPath = path.join(binDir, `${binaryName}.cmd`);
    // Never shim a farm entry to itself (scan can hand us the shim back).
    if (path.resolve(targetPath) === path.resolve(shimPath)) return shimPath;
    const body = `@echo off\r\n${SHIM_MARKER}\r\n"${targetPath}" %*\r\n`;
    if (existsSync(shimPath)) {
      let existing = '';
      try {
        existing = readFileSync(shimPath, 'utf-8');
      } catch {
        return null; // unreadable — assume it is someone else's and leave it
      }
      if (!existing.includes(SHIM_MARKER)) return null; // real file — hands off
      if (existing === body) return shimPath; // already correct
    }
    writeFileSync(shimPath, body);
    console.log(`[cli-locate] Shimmed ${binaryName} -> ${targetPath} in the o8 bin dir`);
    return shimPath;
  } catch (err) {
    console.warn(`[cli-locate] Could not shim ${binaryName} into the o8 bin dir:`, err);
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
