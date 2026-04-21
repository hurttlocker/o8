/**
 * Shared CLI binary resolver for o8 runtime adapters.
 *
 * Provides a consistent, caching mechanism to locate CLI binaries (codex,
 * claude, gemini, opencode, …) across all the environments where o8 runs:
 * - Standard PATH installs (npm global, brew, cargo)
 * - Version managers (nvm, fnm, asdf, volta) wired only to the login shell
 * - Tauri / Finder-launched apps whose child PATH is stripped to a bare minimum
 *
 * Resolution order (first hit wins):
 *   1. process.env[spec.envOverride]   — e.g. O8_CODEX_BIN
 *   2. which <binary>                  — uses the child process's PATH
 *   3. Login-shell probe               — $SHELL -lc 'command -v <binary>'
 *      catches nvm/fnm/volta/asdf because those tools init via shell rc files
 *   4. Static fallback paths           — ~/.npm-global, ~/.asdf/shims, etc.
 */

import { execFile } from 'node:child_process';
import { stat } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const statAsync = promisify(stat);

// ── Public types ──────────────────────────────────────────────────────────────

export interface ResolvedCli {
  /** Absolute path, symlinks resolved where possible. */
  path: string;
  /** Which strategy found this binary. */
  source: 'env' | 'which' | 'login-shell' | 'npm-global' | 'asdf' | 'volta' | 'fnm' | 'brew' | 'default';
  /** Parsed version string (if versionArgs were provided and succeeded). */
  version?: string;
  /** Unix timestamp (ms) when this result was resolved. */
  detectedAt: number;
  /** The env-var name that triggered resolution (if source === 'env'). */
  envHint?: string;
}

export interface CliResolverSpec {
  /** Logical name for the runtime: 'codex' | 'claude-code' | 'gemini' | 'opencode' */
  runtimeId: string;
  /** The binary name to search for: 'codex', 'claude', etc. */
  binaryName: string;
  /**
   * Primary env-var override key (convention: O8_<RUNTIME>_BIN, e.g. O8_CODEX_BIN).
   * Checked first — if set and the path exists we use it immediately.
   */
  envOverride: string;
  /** Additional env-var overrides checked after envOverride (e.g. CLAUDE_BIN). */
  extraEnvOverrides?: string[];
  /** Extra binary names to check alongside binaryName (e.g. ['claude-code']). */
  aliases?: string[];
  /** Args to pass when probing for the version, defaults to ['--version']. */
  versionArgs?: string[];
  /** Regex to extract a semver-like version from the version output. */
  versionPattern?: RegExp;
}

/** Thrown when a binary cannot be found via any strategy. */
export class CliNotFoundError extends Error {
  public readonly triedPaths: string[];

  constructor(binaryName: string, triedPaths: string[]) {
    super(
      `[cli-resolver] Binary '${binaryName}' not found. Tried: ${triedPaths.join(', ')}`,
    );
    this.name = 'CliNotFoundError';
    this.triedPaths = triedPaths;
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60_000; // 10 minutes

interface CacheEntry {
  resolved: ResolvedCli;
  cachedAt: number;
}

const resolverCache = new Map<string, CacheEntry>();

/**
 * Invalidate the cached resolution for one runtime, or all runtimes when
 * runtimeId is omitted.
 */
export function invalidateCliCache(runtimeId?: string): void {
  if (runtimeId === undefined) {
    resolverCache.clear();
    console.log('[cli-resolver] All CLI resolution cache entries cleared.');
  } else {
    const deleted = resolverCache.delete(runtimeId);
    if (deleted) {
      console.log(`[cli-resolver] Cache cleared for runtime '${runtimeId}'.`);
    }
  }
}

/**
 * Return the cached resolution for a runtime without triggering a new probe.
 * Returns undefined if not cached or if the entry has expired.
 */
export function getCachedCli(runtimeId: string): ResolvedCli | undefined {
  const entry = resolverCache.get(runtimeId);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    resolverCache.delete(runtimeId);
    return undefined;
  }
  return entry.resolved;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Returns true when the path exists and is executable. */
async function canExec(binPath: string): Promise<boolean> {
  try {
    await statAsync(binPath);
    // stat succeeded → file exists; we assume it's executable if the caller
    // provided a path (env override or static fallback) since we can't easily
    // check execute permission in a cross-platform way without spawning.
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe the binary version using the spec's versionArgs.
 * Returns undefined on any failure — version info is best-effort.
 */
async function probeVersion(
  binPath: string,
  spec: CliResolverSpec,
): Promise<string | undefined> {
  const args = spec.versionArgs ?? ['--version'];
  const pattern = spec.versionPattern ?? /\b(\d+\.\d+\.\d+)\b/;
  try {
    const { stdout, stderr } = await execFileAsync(binPath, args, {
      timeout: 5_000,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const combined = `${stdout}\n${stderr}`;
    const match = combined.match(pattern);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Build the list of static fallback directories ordered by likelihood. */
function staticFallbackDirs(): Array<{ dir: string; source: ResolvedCli['source'] }> {
  const home = os.homedir();
  return [
    { dir: path.join(home, '.npm-global', 'bin'), source: 'npm-global' },
    { dir: path.join(home, '.asdf', 'shims'), source: 'asdf' },
    { dir: path.join(home, '.volta', 'bin'), source: 'volta' },
    { dir: path.join(home, '.fnm', 'aliases', 'default', 'bin'), source: 'fnm' },
    { dir: '/opt/homebrew/bin', source: 'brew' },
    { dir: '/usr/local/bin', source: 'default' },
    { dir: '/usr/bin', source: 'default' },
  ];
}

/**
 * Determine the binary names to search for (primary + aliases).
 */
function binaryNames(spec: CliResolverSpec): string[] {
  return [spec.binaryName, ...(spec.aliases ?? [])];
}

// ── Resolution strategies ─────────────────────────────────────────────────────

/** Strategy 1: explicit env-var overrides. */
async function resolveViaEnv(
  spec: CliResolverSpec,
): Promise<ResolvedCli | null> {
  const envKeys = [spec.envOverride, ...(spec.extraEnvOverrides ?? [])];
  for (const key of envKeys) {
    const value = process.env[key];
    if (!value) continue;
    const exists = await canExec(value);
    if (!exists) {
      console.log(`[cli-resolver] Env override ${key}='${value}' set but path does not exist — skipping.`);
      continue;
    }
    console.log(`[cli-resolver] Using ${spec.binaryName} from env override ${key}='${value}'.`);
    const version = await probeVersion(value, spec);
    return {
      path: value,
      source: 'env',
      version,
      detectedAt: Date.now(),
      envHint: key,
    };
  }
  return null;
}

/** Strategy 2: `which <binary>` — relies on the child process PATH. */
async function resolveViaWhich(
  spec: CliResolverSpec,
): Promise<ResolvedCli | null> {
  for (const name of binaryNames(spec)) {
    try {
      const { stdout } = await execFileAsync('which', [name], {
        timeout: 3_000,
      });
      const found = stdout.trim();
      if (!found) continue;
      console.log(`[cli-resolver] 'which ${name}' found: ${found}`);
      const version = await probeVersion(found, spec);
      return {
        path: found,
        source: 'which',
        version,
        detectedAt: Date.now(),
      };
    } catch {
      // which exited non-zero → binary not on PATH
    }
  }
  return null;
}

/**
 * Strategy 3: login-shell probe.
 *
 * Runs `$SHELL -lc 'command -v <binary>'`, which sources the user's shell
 * init files (~/.zshrc, ~/.bash_profile, …) where nvm/fnm/volta/asdf inject
 * themselves. This is the key strategy that survives Finder-launched apps with
 * a stripped PATH. Mirrors the Rust pattern in src-tauri/src/lib.rs.
 */
async function resolveViaLoginShell(
  spec: CliResolverSpec,
): Promise<ResolvedCli | null> {
  const userShell = process.env.SHELL;
  const shells: string[] = [];
  if (userShell) shells.push(userShell);
  // Fallback shell sequence matching the Rust implementation
  for (const sh of ['zsh', 'bash', 'sh']) {
    if (!shells.includes(sh)) shells.push(sh);
  }

  for (const sh of shells) {
    for (const name of binaryNames(spec)) {
      try {
        const { stdout } = await execFileAsync(sh, ['-l', '-c', `command -v ${name}`], {
          timeout: 10_000,
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        });
        const found = stdout.trim();
        if (!found) continue;
        console.log(`[cli-resolver] Login-shell probe (${sh}) found ${name}: ${found}`);
        const version = await probeVersion(found, spec);
        return {
          path: found,
          source: 'login-shell',
          version,
          detectedAt: Date.now(),
        };
      } catch {
        // This shell or binary not available — try next
      }
    }
  }
  return null;
}

/** Strategy 4: static fallback paths. */
async function resolveViaStaticFallbacks(
  spec: CliResolverSpec,
): Promise<ResolvedCli | null> {
  const fallbacks = staticFallbackDirs();
  for (const { dir, source } of fallbacks) {
    for (const name of binaryNames(spec)) {
      const candidate = path.join(dir, name);
      if (await canExec(candidate)) {
        console.log(`[cli-resolver] Static fallback found ${name} at ${candidate} (source: ${source}).`);
        const version = await probeVersion(candidate, spec);
        return {
          path: candidate,
          source,
          version,
          detectedAt: Date.now(),
        };
      }
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the absolute path for a CLI binary, using a layered strategy that
 * survives stripped PATH environments (Tauri/Finder-launched apps) and all
 * common version managers.
 *
 * Results are cached per runtimeId for 10 minutes. Call invalidateCliCache()
 * to force a fresh probe.
 *
 * Throws CliNotFoundError when the binary cannot be located anywhere.
 */
export async function resolveCli(spec: CliResolverSpec): Promise<ResolvedCli> {
  // Cache hit check
  const cached = getCachedCli(spec.runtimeId);
  if (cached) {
    return cached;
  }

  console.log(`[cli-resolver] Resolving '${spec.binaryName}' for runtime '${spec.runtimeId}'...`);

  const triedPaths: string[] = [];

  // --- Strategy 1: env overrides ---
  const fromEnv = await resolveViaEnv(spec);
  if (fromEnv) {
    resolverCache.set(spec.runtimeId, { resolved: fromEnv, cachedAt: Date.now() });
    return fromEnv;
  }
  const envKeys = [spec.envOverride, ...(spec.extraEnvOverrides ?? [])].filter((k) => process.env[k]);
  if (envKeys.length === 0) {
    // Only record "tried env" when env vars weren't set — otherwise we already logged
    triedPaths.push(`env:${spec.envOverride}`);
  }

  // --- Strategy 2: which ---
  const fromWhich = await resolveViaWhich(spec);
  if (fromWhich) {
    resolverCache.set(spec.runtimeId, { resolved: fromWhich, cachedAt: Date.now() });
    return fromWhich;
  }
  for (const name of binaryNames(spec)) {
    triedPaths.push(`which:${name}`);
  }

  // --- Strategy 3: login-shell ---
  const fromShell = await resolveViaLoginShell(spec);
  if (fromShell) {
    resolverCache.set(spec.runtimeId, { resolved: fromShell, cachedAt: Date.now() });
    return fromShell;
  }
  for (const name of binaryNames(spec)) {
    triedPaths.push(`login-shell:${name}`);
  }

  // --- Strategy 4: static fallbacks ---
  const fromFallback = await resolveViaStaticFallbacks(spec);
  if (fromFallback) {
    resolverCache.set(spec.runtimeId, { resolved: fromFallback, cachedAt: Date.now() });
    return fromFallback;
  }
  for (const { dir } of staticFallbackDirs()) {
    for (const name of binaryNames(spec)) {
      triedPaths.push(path.join(dir, name));
    }
  }

  throw new CliNotFoundError(spec.binaryName, triedPaths);
}
