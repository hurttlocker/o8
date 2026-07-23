/**
 * Tier-2 worker sandboxing (#1325) — OS-level isolation for locally-dispatched
 * workers.
 *
 * o8 spawns local Codex/Claude workers as the operator's OWN uid. Tier-1 (the
 * RF-1 request-principal model) stops a prompt-injected worker from driving the
 * `o8` CLI to resolve its own approvals, but it does NOT stop a fully-malicious
 * worker that reads the operator's on-disk secrets directly
 * (`~/.o8/ws-token`, `~/.o8/worker-token`, the `/tmp/tauri-mcp-o8-*` webview
 * socket + its `.token` sidefile) and impersonates the operator.
 *
 * This module wraps the worker child process with macOS `sandbox-exec` and a
 * generated seatbelt (SBPL) profile: deny-by-default file access, with reads
 * scoped to the toolchain/system paths node/git/codex/claude need, read+write
 * scoped to the packet worktree + repo + TMPDIR, network allowed (so the RF-1
 * HTTP path to the gated loopback API keeps working), and EXPLICIT denials on
 * `~/.o8`, `~/.tauri`, and the webview socket so those secrets are unreachable.
 *
 * NOTE: `sandbox-exec` is deprecated by Apple (since 10.14) but remains fully
 * functional and is still how Chrome/Firefox/many tools sandbox helpers today.
 * The module is intentionally shaped as a policy backend so a future
 * container/uid backend can slot in behind {@link prepareWorkerSandbox} without
 * touching the spawn chokepoint.
 *
 * FEATURE GATE: off by default. Enable with `O8_WORKER_SANDBOX=on` (or
 * 1/true/yes). When ON the semantics are FAIL-CLOSED — if the profile cannot be
 * built (non-macOS host, missing `sandbox-exec`, unwritable profile file) the
 * caller refuses to spawn rather than silently running the worker unsandboxed.
 */

import { realpath, writeFile } from 'node:fs/promises';
import { access, constants as fsConstants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Absolute path to Apple's seatbelt runner. */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** Raised when a sandbox was requested but cannot be provided. Fail-closed. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

/**
 * Is Tier-2 worker sandboxing enabled? Off by default so day-one dispatch can
 * never be bricked; the operator opts in via `O8_WORKER_SANDBOX`.
 */
export function workerSandboxEnabled(): boolean {
  const raw = process.env.O8_WORKER_SANDBOX?.trim().toLowerCase();
  if (!raw) return false;
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes';
}

/** SBPL string-literal escaping — backslashes and double-quotes. */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `(subpath "…")` filter, SBPL-escaped. */
function subpath(p: string): string {
  return `(subpath ${sbplString(p)})`;
}

function regexFragment(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replace(/"/g, '\\"');
}

/** best-effort realpath; falls back to the input when it doesn't resolve yet. */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** unique, order-preserving. */
function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

/** Package root for an npm-installed binary target, including scoped packages. */
function nodePackageRoot(binaryPath: string): string | null {
  const parsed = path.parse(binaryPath);
  const segments = binaryPath.slice(parsed.root.length).split(path.sep);
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (nodeModulesIndex < 0 || !segments[nodeModulesIndex + 1]) return null;
  const packageSegments = segments[nodeModulesIndex + 1].startsWith('@') ? 2 : 1;
  const end = nodeModulesIndex + 1 + packageSegments;
  if (segments.length < end) return null;
  return path.join(parsed.root, ...segments.slice(0, end));
}

export interface SeatbeltProfileInput {
  /** The worktree / repo cwd the worker runs in (read+write). */
  worktreePath: string;
  /** The backing repo path the worktree needs (read+write; often === worktree). */
  repoPath: string;
  /** Operator HOME — used to locate the secret trees that must be denied. */
  homeDir: string;
  /** TMPDIR the toolchain scribbles into (read+write). */
  tmpDir: string;
  /** Extra read+write roots (e.g. a worktree's parent `.git`). */
  extraReadWritePaths?: string[];
  /** Extra read-only roots (toolchain dirs resolved by the caller). */
  extraReadPaths?: string[];
  /** Additional credential/control-plane roots that must stay unreachable. */
  extraDenyPaths?: string[];
  /** Narrow state roots re-opened after broad secret-tree denials. */
  trustedReadWritePaths?: string[];
  /** Files or subtrees denied after trusted state is re-opened. */
  finalDenyPaths?: string[];
  /** Narrow state roots re-opened after a final parent-subtree denial. */
  finalAllowReadWritePaths?: string[];
  /** Executables denied after the broad process-exec allow. */
  finalDenyExecPaths?: string[];
  /** Executable basename prefixes denied regardless of installation path. */
  finalDenyExecNamePrefixes?: string[];
  /** Exact basenames denied read access regardless of installation path. */
  finalDenyReadBasenames?: string[];
  /** Files or subtrees that remain readable but cannot be modified. */
  finalDenyWritePaths?: string[];
  /** Files kept immutable after a narrow mutable state root is re-opened. */
  finalImmutableWritePaths?: string[];
  /** Exact files re-opened for reads after a parent subtree is denied. */
  finalAllowReadPaths?: string[];
  /** Exact executables re-opened after a parent subtree is exec-denied. */
  finalAllowExecPaths?: string[];
}

/**
 * Build the seatbelt (SBPL) profile text. Pure + deterministic given canonical
 * inputs, so it is unit-testable in isolation. Caller is responsible for
 * canonicalising paths (see {@link prepareWorkerSandbox}).
 *
 * Ordering matters: SBPL is LAST-MATCH-WINS, so the secret denials are emitted
 * AFTER every allow — they override any broad allow that happened to match.
 */
export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
  const home = input.homeDir.replace(/\/+$/, '');

  // System + toolchain read roots. node/git/codex/claude read dylibs, configs,
  // and CLI shims from all over the system; deny-default reads without these
  // would break the worker outright. HOME is deliberately NOT allowed wholesale
  // — only the specific toolchain subdirs below — so `~/.o8` stays denied.
  const systemReadRoots = uniq([
    '/usr', '/bin', '/sbin', '/System', '/Library', '/private/var',
    '/private/etc', '/etc', '/var', '/opt', '/dev', '/Applications',
    '/tmp', '/private/tmp',
  ]);

  // Toolchain dirs under HOME the CLIs legitimately read (auth, caches,
  // configs). Never includes `.o8` / `.tauri`.
  const homeToolchainDirs = uniq([
    '.nvm', '.volta', '.n', '.local', '.npm', '.cache', '.config',
    '.codex', '.claude', '.yarn', '.pnpm-store', '.asdf', '.rustup',
    '.cargo', '.bun', '.deno',
  ].map((d) => path.join(home, d)));

  // Individual dotfiles the CLIs read (git identity, npm registry, etc.).
  // `.zshenv` is deliberately ABSENT: it commonly exports the operator's API
  // keys, and workers inherit their env from the trusted parent — a shell that
  // can't read it just skips it.
  const homeToolchainFiles = uniq([
    '.gitconfig', '.gitignore', '.npmrc', '.yarnrc',
  ].map((f) => path.join(home, f)));

  const readRoots = uniq([
    ...systemReadRoots,
    ...homeToolchainDirs,
    ...(input.extraReadPaths ?? []),
  ]);

  const rwRoots = uniq([
    input.worktreePath,
    input.repoPath,
    input.tmpDir,
    ...(input.extraReadWritePaths ?? []),
  ]);

  // Secret trees that must be unreachable regardless of anything above.
  const secretRoots = uniq([
    getDataDir({}, home),
    path.join(home, '.cortex-ide'),
    path.join(home, '.tauri'),
    // gh CLI credential store (~/.config/gh/hosts.yml holds the operator's
    // GitHub OAuth token). `.config` is read-allowed above for git's sake;
    // workers report through the `o8` CLI and never need gh, so cut this off.
    path.join(home, '.config', 'gh'),
    ...(input.extraDenyPaths ?? []),
  ]);

  const trustedReadWritePaths = uniq(input.trustedReadWritePaths ?? []);
  const finalDenyPaths = uniq(input.finalDenyPaths ?? []);
  const finalAllowReadWritePaths = uniq(input.finalAllowReadWritePaths ?? []);
  const finalDenyExecPaths = uniq(input.finalDenyExecPaths ?? []);
  const finalDenyExecNamePrefixes = uniq(input.finalDenyExecNamePrefixes ?? []);
  const finalDenyReadBasenames = uniq(input.finalDenyReadBasenames ?? []);
  const finalDenyWritePaths = uniq(input.finalDenyWritePaths ?? []);
  const finalImmutableWritePaths = uniq(input.finalImmutableWritePaths ?? []);
  const finalAllowReadPaths = uniq(input.finalAllowReadPaths ?? []);
  const finalAllowExecPaths = uniq(input.finalAllowExecPaths ?? []);

  const lines: string[] = [
    '(version 1)',
    '',
    ';; Tier-2 worker sandbox (#1325). sandbox-exec is deprecated-but-functional.',
    ';; Deny-by-default; last matching rule wins.',
    '(deny default)',
    '',
    ';; --- process / IPC / mach (needed to exec node + toolchain) ---',
    '(allow process-exec*)',
    '(allow process-fork)',
    '(allow process-info*)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm*)',
    '(allow system-socket)',
    '',
    ';; --- network: RF-1 HTTP to the gated loopback API must keep working ---',
    '(allow network*)',
    '',
    ';; --- metadata reads globally (path resolution / stat) ---',
    '(allow file-read-metadata)',
    '',
    ';; --- read: system + toolchain roots ---',
    `(allow file-read*`,
    // The root directory entry itself: dyld/exec abort (SIGABRT) at launch
    // without read access to "/", even though every real payload lives under a
    // subpath below. `literal` grants only the "/" dirent, not a recursive `/`.
    '  (literal "/")',
    ...readRoots.map((p) => `  ${subpath(p)}`),
    ...homeToolchainFiles.map((p) => `  (literal ${sbplString(p)})`),
    ')',
    '',
    ';; --- read+write: the worktree, its repo, and TMPDIR ---',
    `(allow file-read* file-write*`,
    ...rwRoots.map((p) => `  ${subpath(p)}`),
    ')',
    '',
    ';; --- write: scratch devices ---',
    `(allow file-write-data`,
    `  (literal "/dev/null")`,
    `  (literal "/dev/dtracehelper")`,
    `  (literal "/dev/tty")`,
    ')',
    '',
    ';; --- DENY the operator secrets LAST so they win over any allow above ---',
    `(deny file-read* file-write*`,
    ...secretRoots.map((p) => `  ${subpath(p)}`),
    ')',
    ';; webview control socket (+ its .token sidefile) — deny both /tmp forms',
    '(deny file-read* file-write*',
    '  (regex #"^/private/tmp/tauri-mcp-o8-")',
    '  (regex #"^/tmp/tauri-mcp-o8-")',
    ')',
    ';; existing tmux servers can otherwise spawn an unsandboxed child',
    '(deny file-read* file-write*',
    '  (regex #"^/private/tmp/tmux-")',
    '  (regex #"^/tmp/tmux-")',
    ')',
    '(deny network-outbound',
    '  (remote unix-socket (regex #"^/private/tmp/tmux-"))',
    '  (remote unix-socket (regex #"^/tmp/tmux-"))',
    ')',
    ...(trustedReadWritePaths.length ? [
      ';; explicitly re-open narrow runtime state inside a denied parent',
      '(allow file-read* file-write*',
      ...trustedReadWritePaths.map((p) => `  ${subpath(p)}`),
      ')',
    ] : []),
    ...(finalDenyPaths.length ? [
      ';; keep credential-bearing files closed inside trusted runtime state',
      '(deny file-read* file-write*',
      ...finalDenyPaths.flatMap((p) => [
        `  (literal ${sbplString(p)})`,
        `  ${subpath(p)}`,
      ]),
      ')',
    ] : []),
    ...(finalDenyExecPaths.length ? [
      ';; prevent a sandboxed process from re-launching protected runtimes',
      '(deny process-exec',
      ...finalDenyExecPaths.flatMap((p) => [
        `  (literal ${sbplString(p)})`,
        `  ${subpath(p)}`,
      ]),
      ')',
    ] : []),
    ...(finalDenyExecNamePrefixes.length ? [
      '(deny process-exec',
      ...finalDenyExecNamePrefixes.map((name) => (
        `  (regex #"(^|/)${regexFragment(name)}(?:$|[-.])")`
      )),
      ')',
    ] : []),
    ...(finalDenyWritePaths.length ? [
      ';; immutable launch policy and guards',
      '(deny file-write* file-write-mode file-write-owner file-write-acl file-write-flags file-link file-clone',
      ...finalDenyWritePaths.flatMap((p) => [
        `  (literal ${sbplString(p)})`,
        `  ${subpath(p)}`,
      ]),
      ')',
    ] : []),
    ...(finalAllowReadWritePaths.length ? [
      ';; re-open only this launch\'s isolated mutable runtime state',
      '(allow file-read* file-write*',
      ...finalAllowReadWritePaths.map((p) => `  ${subpath(p)}`),
      ')',
    ] : []),
    ...(finalImmutableWritePaths.length ? [
      ';; keep policy files immutable inside the active state root',
      '(deny file-write* file-write-mode file-write-owner file-write-acl file-write-flags file-link file-clone',
      ...finalImmutableWritePaths.flatMap((p) => [
        `  (literal ${sbplString(p)})`,
        `  ${subpath(p)}`,
      ]),
      ')',
    ] : []),
    ...(finalDenyReadBasenames.length ? [
      '(deny file-read*',
      ...finalDenyReadBasenames.map((name) => (
        `  (regex #"(^|/)${regexFragment(name)}$")`
      )),
      ')',
    ] : []),
    ...(finalAllowReadPaths.length ? [
      ';; re-open only the active private runtime image for initial launch',
      '(allow file-read*',
      ...finalAllowReadPaths.map((p) => `  (literal ${sbplString(p)})`),
      ')',
    ] : []),
    ...(finalAllowExecPaths.length ? [
      '(allow process-exec',
      ...finalAllowExecPaths.map((p) => `  (literal ${sbplString(p)})`),
      ')',
    ] : []),
    '',
  ];

  return lines.join('\n');
}

export interface PreparedSandbox {
  /** The wrapper binary to spawn instead of the raw CLI (sandbox-exec). */
  binary: string;
  /** `['-f', <profilePath>, <origBinary>, ...origArgs]`. */
  args: string[];
  /** Where the generated profile was written. */
  profilePath: string;
  /** The profile text (for logging / tests). */
  profileText: string;
}

export interface PrepareWorkerSandboxInput {
  runId: string;
  /** Directory to write the generated `<runId>.sb` profile into. */
  profileDir: string;
  /** The worker's cwd (packet worktree). */
  cwd: string;
  /** The backing repo path (read+write). */
  repoPath: string;
  /** The resolved CLI binary path being wrapped. */
  binary: string;
  /** The CLI args. */
  args: string[];
  homeDir?: string;
  tmpDir?: string;
  /** Extra read+write roots (e.g. the main repo `.git` a worktree needs). */
  extraReadWritePaths?: string[];
  /** Extra read-only roots (e.g. node runtime dir, CLI binary dir). */
  extraReadPaths?: string[];
  extraDenyPaths?: string[];
  trustedReadWritePaths?: string[];
  finalDenyPaths?: string[];
  finalAllowReadWritePaths?: string[];
  finalDenyExecPaths?: string[];
  finalDenyExecNamePrefixes?: string[];
  finalDenyReadBasenames?: string[];
  finalDenyWritePaths?: string[];
  finalImmutableWritePaths?: string[];
  finalAllowReadPaths?: string[];
  finalAllowExecPaths?: string[];
}

/**
 * Assemble the sandbox-exec invocation that wraps a worker child. FAIL-CLOSED:
 * throws {@link SandboxUnavailableError} on any host where the sandbox cannot
 * be provided, so the caller refuses to spawn rather than degrading to an
 * unsandboxed worker.
 */
export async function prepareWorkerSandbox(input: PrepareWorkerSandboxInput): Promise<PreparedSandbox> {
  if (process.platform !== 'darwin') {
    throw new SandboxUnavailableError(
      `Worker sandbox is macOS-only (sandbox-exec); host platform is '${process.platform}'. `
      + `Unset O8_WORKER_SANDBOX to dispatch unsandboxed.`,
    );
  }
  try {
    await access(SANDBOX_EXEC_PATH, fsConstants.X_OK);
  } catch {
    throw new SandboxUnavailableError(`sandbox-exec not found or not executable at ${SANDBOX_EXEC_PATH}.`);
  }

  const home = input.homeDir ?? os.homedir();
  const tmp = input.tmpDir ?? os.tmpdir();

  // Canonicalise so symlinked roots (/tmp → /private/tmp, worktrees) match the
  // kernel's realpath during policy evaluation. Include both the raw and
  // resolved form where they differ.
  const worktreeReal = await safeRealpath(input.cwd);
  const repoReal = await safeRealpath(input.repoPath);
  const tmpReal = await safeRealpath(tmp);
  const homeReal = await safeRealpath(home);
  const binaryDir = path.dirname(input.binary);
  const binaryDirReal = await safeRealpath(binaryDir);
  const binaryReal = await safeRealpath(input.binary);
  const binaryPackageRoot = nodePackageRoot(binaryReal);
  const nodeDir = path.dirname(process.execPath);
  const nodeDirReal = await safeRealpath(nodeDir);

  const extraRW = uniq([
    input.cwd, worktreeReal,
    input.repoPath, repoReal,
    tmp, tmpReal,
    ...(input.extraReadWritePaths ?? []),
  ]);
  const extraRead = uniq([
    binaryDir, binaryDirReal, path.dirname(binaryReal),
    ...(binaryPackageRoot ? [binaryPackageRoot] : []),
    nodeDir, nodeDirReal,
    ...(input.extraReadPaths ?? []),
  ]);
  const resolveAll = async (paths: string[]): Promise<string[]> => {
    const resolved = await Promise.all(paths.map((value) => safeRealpath(value)));
    return uniq(paths.flatMap((value, index) => [value, resolved[index]]));
  };
  const extraDeny = await resolveAll(input.extraDenyPaths ?? []);
  const trustedReadWrite = await resolveAll(input.trustedReadWritePaths ?? []);
  const finalDeny = await resolveAll(input.finalDenyPaths ?? []);
  const finalAllowReadWrite = await resolveAll(input.finalAllowReadWritePaths ?? []);
  const finalDenyExec = await resolveAll(input.finalDenyExecPaths ?? []);
  const finalDenyExecNamePrefixes = uniq(input.finalDenyExecNamePrefixes ?? []);
  const finalDenyReadBasenames = uniq(input.finalDenyReadBasenames ?? []);
  const finalDenyWrite = await resolveAll(input.finalDenyWritePaths ?? []);
  const finalImmutableWrite = await resolveAll(input.finalImmutableWritePaths ?? []);
  const finalAllowRead = await resolveAll(input.finalAllowReadPaths ?? []);
  const finalAllowExec = await resolveAll(input.finalAllowExecPaths ?? []);

  const profileText = buildSeatbeltProfile({
    worktreePath: worktreeReal,
    repoPath: repoReal,
    homeDir: homeReal,
    tmpDir: tmpReal,
    extraReadWritePaths: extraRW,
    extraReadPaths: extraRead,
    extraDenyPaths: extraDeny,
    trustedReadWritePaths: trustedReadWrite,
    finalDenyPaths: finalDeny,
    finalAllowReadWritePaths: finalAllowReadWrite,
    finalDenyExecPaths: finalDenyExec,
    finalDenyExecNamePrefixes,
    finalDenyReadBasenames,
    finalDenyWritePaths: finalDenyWrite,
    finalImmutableWritePaths: finalImmutableWrite,
    finalAllowReadPaths: finalAllowRead,
    finalAllowExecPaths: finalAllowExec,
  });

  const profilePath = path.join(input.profileDir, `${input.runId}.sb`);
  try {
    await writeFile(profilePath, profileText, { mode: 0o600 });
  } catch (error) {
    throw new SandboxUnavailableError(
      `Failed to write seatbelt profile to ${profilePath}: ${(error as Error).message}`,
    );
  }

  return {
    binary: SANDBOX_EXEC_PATH,
    args: ['-f', profilePath, input.binary, ...input.args],
    profilePath,
    profileText,
  };
}
