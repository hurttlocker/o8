import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface TsxProcessCommand {
  args: string[];
  file: string;
}

function resolvePrimaryCheckoutRoot(cwd: string): string | null {
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
        windowsHide: true,
      },
    ).trim();
    return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
  } catch {
    return null;
  }
}

function resolveTsxEntry(anchor: string): string | null {
  try {
    return createRequire(path.join(anchor, 'package.json')).resolve('tsx/cli');
  } catch {
    return null;
  }
}

/**
 * Resolve the real tsx JavaScript entry for a cross-process test.
 *
 * Linked worktrees can omit node_modules entirely, so resolution falls back to
 * the primary checkout that owns their shared Git common directory. Running
 * the entry through process.execPath also avoids platform-specific .bin shims.
 */
export function resolveTsxProcess(
  args: readonly string[],
  cwd = process.cwd(),
): TsxProcessCommand {
  const resolvedCwd = path.resolve(cwd);
  const primaryRoot = resolvePrimaryCheckoutRoot(resolvedCwd);
  const anchors = [...new Set([
    resolvedCwd,
    primaryRoot,
  ].filter((value): value is string => Boolean(value)))];
  for (const anchor of anchors) {
    const entry = resolveTsxEntry(anchor);
    if (entry) return { file: process.execPath, args: [entry, ...args] };
  }

  throw new Error(
    `Unable to resolve tsx/cli for a cross-process test from ${resolvedCwd}. `
    + `Checked dependency roots: ${anchors.join(', ') || '(none)'}. `
    + 'Install dependencies in the checkout that owns this Git worktree.',
  );
}
