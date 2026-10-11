import { stat } from 'node:fs/promises';

import { detectTypecheckAvailability } from '@/lib/lane/typecheck-availability';

async function isDirectory(directory: string | null | undefined): Promise<boolean> {
  if (!directory?.trim()) return false;
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/** Prompt assembly may precede worktree provisioning; never inspect the host's cwd. */
export async function buildProjectVerificationPrompt(
  worktreePath: string | null | undefined,
  repoPath: string | null | undefined,
): Promise<string> {
  const observedPath = await isDirectory(worktreePath) ? worktreePath
    : await isDirectory(repoPath) ? repoPath : null;
  const availability = observedPath ? await detectTypecheckAvailability(observedPath) : null;
  const projectGuidance = availability === 'no-project'
    ? 'No root tsconfig.json was found in the observed target project. `npx tsc --noEmit` is not an applicable generic gate for this snapshot. Check repository instructions for nested TypeScript projects or other required verification; run the applicable documentation, test, lint, or build checks.'
    : availability === null
      ? 'Target-project TypeScript availability could not be established. Inspect the worker worktree and repository instructions before selecting checks; do not claim a check passed or was inapplicable without evidence.'
      : [
        'A root tsconfig.json was found. TypeScript verification remains required: use the repository-prescribed typecheck command, or `npx --no-install tsc --noEmit` with the local TypeScript compiler.',
        availability === 'available'
          ? 'A local TypeScript compiler was found in the observed target project.'
          : 'A local TypeScript compiler was not found in the observed target project. This is an unavailable check, not a non-TypeScript project or a passing typecheck.',
        'Recheck compiler availability in the worker worktree after dependency setup. If the compiler is still missing, report a verification blocker and the required project dependency setup; do not silently waive the check. Real type errors must be fixed and the check rerun.',
      ].join(' ');
  return [
    'Verification discipline: Follow the target repository verification rules (including AGENTS.md and project scripts) and the task acceptance criteria. This guidance does not replace or relax required checks.',
    projectGuidance,
    'These observations were made during prompt assembly; recheck applicability in the actual worker worktree, including any TypeScript project added by your changes. Do not download a compiler or an unrelated npm package to satisfy a generic instruction. Use the project dependency setup and locally installed tools.',
    'Run changed-file checks where supported, preserve repository-required test and build gates, and report each check as passed, failed, unavailable, or inapplicable with evidence. Hand off committed implementation and any blockers promptly for independent review; do not claim the user-facing outcome is closed from a commit alone.',
  ].join('\n');
}
