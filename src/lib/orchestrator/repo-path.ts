import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const ORCHESTRATOR_HOME_REPO_SENTINEL = '~';

/** Resolve the client-only home sentinel before session identity is derived. */
export function resolveOrchestratorRepoPath(repoPath: string | null | undefined): string | null {
  const trimmed = repoPath?.trim();
  if (!trimmed) return null;
  const home = homedir();
  const expanded = trimmed === ORCHESTRATOR_HOME_REPO_SENTINEL
    ? home
    : trimmed.startsWith('~/')
      ? join(home, trimmed.slice(2))
      : trimmed;
  return resolve(expanded);
}

export function resolveOrchestratorMessageRepoPath(message: Record<string, unknown>): string | null {
  return resolveOrchestratorRepoPath(
    typeof message.repoPath === 'string' ? message.repoPath : null,
  );
}

export function isOrchestratorHomePath(repoPath: string | null | undefined): boolean {
  const resolved = resolveOrchestratorRepoPath(repoPath);
  return resolved === resolve(homedir());
}
