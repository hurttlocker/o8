/**
 * How to actually RUN a resolved runtime CLI, per platform.
 *
 * Companion to cli-locate: that module answers "where is the binary", this one
 * answers "what do I hand to spawn()". They are separate because the Windows
 * answer to the second question is not the binary itself.
 *
 * The problem (#1758): npm installs a global CLI on Windows as `<name>.cmd`,
 * and Node has refused to execute `.bat`/`.cmd` files without a shell since
 * 18.20.2 / 20.12.2 (it throws EINVAL). So even after cli-locate correctly
 * finds `claude.cmd`, every direct `spawn(binary, args)` fails. Detection and
 * execution had to be fixed together or the bug just moves one step later.
 *
 * We do NOT use `shell: true`: with that option Node joins the command and
 * arguments into one string with no escaping, which turns any argument
 * containing shell metacharacters into a command-injection hazard. Invoking
 * the interpreter explicitly keeps Node's per-argument quoting.
 *
 * CONSTRAINT: arguments still pass through cmd.exe, which expands `%VAR%` even
 * inside quotes. That is fine for the current callers — every one of them
 * passes flags and model identifiers on argv and sends free-form prompt text
 * over stdin — but do not route untrusted free text through here as an
 * argument without revisiting this.
 */

import path from 'node:path';

export interface CliInvocation {
  command: string;
  args: string[];
}

/** Extensions Windows cannot execute directly — they need a command interpreter. */
const INTERPRETED_ON_WINDOWS = new Set(['.cmd', '.bat']);

/**
 * Translate a resolved CLI path plus its arguments into a spawnable pair.
 *
 * Off Windows, and for real executables on Windows, this is the identity —
 * callers can use it unconditionally without a platform branch at each site.
 */
export function cliInvocation(binaryPath: string, args: string[] = []): CliInvocation {
  if (process.platform !== 'win32') return { command: binaryPath, args };
  if (!INTERPRETED_ON_WINDOWS.has(path.extname(binaryPath).toLowerCase())) {
    return { command: binaryPath, args };
  }
  // `/d` skips any AutoRun command a user has configured in the registry, which
  // would otherwise run before our CLI on every single spawn.
  const comspec = process.env.ComSpec || 'cmd.exe';
  return { command: comspec, args: ['/d', '/c', binaryPath, ...args] };
}

/**
 * True when a spawn of this path will go through an interpreter, so the direct
 * child is cmd.exe and the CLI is a GRANDchild.
 *
 * Callers that terminate sessions need this: `child.kill()` reaches cmd.exe
 * only, leaving the real CLI orphaned. Windows needs `taskkill /pid <pid> /T`
 * to take the whole tree — the same class of gap as #1739, where Windows has
 * no orphan reaping at all.
 */
export function spawnsViaInterpreter(binaryPath: string): boolean {
  return process.platform === 'win32'
    && INTERPRETED_ON_WINDOWS.has(path.extname(binaryPath).toLowerCase());
}
