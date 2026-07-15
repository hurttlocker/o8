import 'server-only';

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { safeJoinReal } from '@/lib/fs/safe-path';

export type TerminalWorkingDirectory = {
  path: string;
  relativePath: string;
} | {
  error: string;
};

/** Resolve and canonicalize a terminal cwd before approval display or use. */
export function resolveTerminalWorkingDirectory(
  repoRoot: string | null,
  cwd?: string,
): TerminalWorkingDirectory {
  if (!repoRoot) {
    return { error: 'Error: No repository is scoped to this chat' };
  }

  const requested = cwd?.trim() || '.';
  const resolved = safeJoinReal(repoRoot, requested);
  if (!resolved) {
    return { error: 'Error: Working directory must resolve within the repository' };
  }

  try {
    const canonicalRoot = realpathSync.native(repoRoot);
    const canonicalPath = realpathSync.native(resolved);
    if (!statSync(canonicalPath).isDirectory()) {
      return { error: 'Error: Working directory must be a directory' };
    }
    const relativePath = relative(canonicalRoot, canonicalPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return { error: 'Error: Working directory must resolve within the repository' };
    }
    return { path: canonicalPath, relativePath: relativePath || '.' };
  } catch {
    return { error: 'Error: Working directory must resolve within the repository' };
  }
}

export function terminalApprovalSummary(
  repoRoot: string | null,
  args: Record<string, unknown>,
): string {
  const command = typeof args.command === 'string' ? args.command : '';
  const requestedCwd = typeof args.cwd === 'string' ? args.cwd : undefined;
  const resolvedCwd = resolveTerminalWorkingDirectory(repoRoot, requestedCwd);
  const displayCwd = 'error' in resolvedCwd
    ? `${requestedCwd?.trim() || '.'} (invalid)`
    : resolvedCwd.relativePath;
  return `Run command in ${displayCwd}: ${command}`;
}

/** Bind approval/grant arguments to the directory the operator actually saw. */
export function canonicalizeTerminalToolArgs(
  repoRoot: string | null,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const requestedCwd = typeof args.cwd === 'string' ? args.cwd : undefined;
  const resolvedCwd = resolveTerminalWorkingDirectory(repoRoot, requestedCwd);
  return 'error' in resolvedCwd
    ? { ...args }
    : { ...args, cwd: resolvedCwd.relativePath };
}
