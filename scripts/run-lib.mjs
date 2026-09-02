/**
 * Shared plumbing for the shell-neutral npm script helpers (#1744).
 *
 * Two Windows facts drive everything here:
 *
 * 1. cmd.exe has no `VAR=value command` prefix syntax, so every package.json
 *    script that set NODE_OPTIONS/PORT that way ran a program literally named
 *    `NODE_OPTIONS=...` and died on a fresh Windows clone.
 * 2. `node_modules/.bin/<name>` is a symlink to the package's JS entry on
 *    macOS/Linux but a `.cmd`/`.ps1` shim on Windows, and Node >= 20.12
 *    refuses to exec a `.cmd` without a shell.
 *
 * Both go away by resolving the package's real JS entry and running it with
 * `process.execPath`: identical program on every platform, no shell in the
 * chain, and the child's PID is the real process rather than a wrapper.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// NODE_OPTIONS resolves relative imports from each child's cwd, so descendants
// launched in worktrees need this module-anchored file URL rather than the legacy token.
const LEGACY_SERVER_ONLY_STUB_NODE_OPTION = '--import=./scripts/register-server-only-stub.mjs';
export const SERVER_ONLY_STUB_NODE_OPTION = `--import=${new URL('./register-server-only-stub.mjs', import.meta.url).href}`;
const SERVER_ONLY_STUB_NODE_OPTION_PATTERN = new RegExp(
  `(^|\\s)(?:${escapeRegExp(LEGACY_SERVER_ONLY_STUB_NODE_OPTION)}|${escapeRegExp(SERVER_ONLY_STUB_NODE_OPTION)})(?=\\s|$)`,
  'g',
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeServerOnlyStubNodeOptions(value, appendIfMissing) {
  let found = false;
  const normalized = value?.replace(SERVER_ONLY_STUB_NODE_OPTION_PATTERN, (_match, prefix) => {
    if (found) return '';
    found = true;
    return `${prefix}${SERVER_ONLY_STUB_NODE_OPTION}`;
  });
  if (found || !appendIfMissing) return normalized;
  return value ? `${value} ${SERVER_ONLY_STUB_NODE_OPTION}` : SERVER_ONLY_STUB_NODE_OPTION;
}

export function canonicalizeServerOnlyStubNodeOptions(value) {
  return normalizeServerOnlyStubNodeOptions(value, false);
}

export function canonicalizeServerOnlyStubEnv(env) {
  const normalized = { ...env };
  if (normalized.NODE_OPTIONS) {
    normalized.NODE_OPTIONS = canonicalizeServerOnlyStubNodeOptions(normalized.NODE_OPTIONS);
  }
  return normalized;
}

export function withServerOnlyStubNodeOptions(value) {
  return normalizeServerOnlyStubNodeOptions(value, true);
}

/**
 * CLI name -> the package subpath its `node_modules/.bin` entry points at.
 * Only the bins the npm scripts actually invoke need an entry; anything else
 * falls back to PATH resolution (with a shell on Windows, for the .cmd shims).
 */
const JS_BINS = {
  next: 'next/dist/bin/next',
  tsx: 'tsx/cli',
};

/**
 * Resolve `command` + `args` into a spawn triple. Known JS bins become
 * `[process.execPath, [entry, ...args], false]`; everything else keeps its
 * name and asks for a shell on Windows only.
 */
export function resolveSpawn(command, args) {
  const subpath = JS_BINS[command];
  if (subpath) {
    try {
      return { file: process.execPath, args: [require.resolve(subpath), ...args], shell: false };
    } catch {
      // Fall through to PATH resolution if the package layout ever moves.
    }
  }
  // Args at every call site are simple tokens (no spaces or shell
  // metacharacters), so the unquoted join a Windows shell does is safe.
  return { file: command, args, shell: process.platform === 'win32' };
}

/**
 * Spawn a child with inherited stdio, forward SIGINT/SIGTERM to it, and exit
 * this process with the child's status — the exit-code and signal semantics
 * the replaced `sh -c '...'` one-liners had.
 */
export function runAndExit(command, args, env = process.env) {
  const { file, args: spawnArgs, shell } = resolveSpawn(command, args);
  const child = spawn(file, spawnArgs, { cwd: process.cwd(), env, stdio: 'inherit', shell });

  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {}
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));

  child.on('error', (err) => {
    process.stderr.write(`[run] failed to spawn ${command}: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    // Die the way the child died — the SIGINT/SIGTERM listeners above are
    // `once`, so the default action applies by now. Same idiom as dev.mjs.
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

/**
 * Split `KEY=VALUE ... -- command args` into an env overlay and the command.
 * Values may contain `=` (NODE_OPTIONS=--import=./x.mjs), so only the first
 * `=` separates — exactly how a POSIX prefix assignment parses.
 */
export function parseEnvPrefixArgv(argv) {
  const assignments = {};
  let i = 0;
  for (; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      i += 1;
      break;
    }
    const eq = token.indexOf('=');
    if (eq <= 0) break;
    assignments[token.slice(0, eq)] = token.slice(eq + 1);
  }
  const rest = argv.slice(i);
  return { assignments, command: rest[0], args: rest.slice(1) };
}
