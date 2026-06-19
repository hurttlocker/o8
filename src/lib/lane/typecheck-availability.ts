import { access } from 'node:fs/promises';
import path from 'node:path';

/**
 * Guards the dispatch typecheck gates against worktrees where `npx tsc` can't
 * actually run — repos with `installOnCreateWorkspace: false` produce a worktree
 * with no `node_modules`, so `npx tsc` falls through to the npm "tsc" SQUATTER
 * package, which prints the marker below and exits non-zero. The gate read that
 * as a type error and bounced the packet into the layer-1 auto-retry forever
 * (#1255). This module lets both gates SKIP-with-warning instead of looping.
 */

// The squatter "tsc" package prints exactly this when the real TypeScript
// compiler isn't installed locally. It is never a type error — treat it as
// "no compiler here".
const MISSING_TSC_MARKER = 'This is not the tsc command you are looking for';

export function isMissingTscOutput(output: string): boolean {
  return output.includes(MISSING_TSC_MARKER);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export interface TypecheckSkip {
  skip: boolean;
  reason?: string;
}

/**
 * Decide whether `npx tsc --noEmit` should run in this worktree at all. Skips
 * when there's no TS project (no tsconfig) or no local compiler to run it
 * (deps not installed). Returns `skip: false` for a normal TS worktree so the
 * typecheck runs exactly as before.
 */
export async function detectTypecheckSkip(cwd: string): Promise<TypecheckSkip> {
  const hasTsconfig = await exists(path.join(cwd, 'tsconfig.json'));
  if (!hasTsconfig) {
    return { skip: true, reason: 'no tsconfig.json (not a TypeScript project)' };
  }
  // Local TypeScript compiler — the bin shim or the package dir.
  const hasLocalTsc =
    (await exists(path.join(cwd, 'node_modules', '.bin', 'tsc')))
    || (await exists(path.join(cwd, 'node_modules', 'typescript', 'package.json')));
  if (!hasLocalTsc) {
    return { skip: true, reason: 'no local TypeScript installed (node_modules missing)' };
  }
  return { skip: false };
}
