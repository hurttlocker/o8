import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type EvalRepoPathSource = 'environment' | 'declared' | 'registry' | 'unresolved';

export interface EvalRepoPathResolution {
  declaredPath: string;
  repoPath: string;
  source: EvalRepoPathSource;
  attemptedPaths: string[];
  registryPath: string;
}

function isGitCheckout(candidate: string): boolean {
  return Boolean(candidate) && fs.existsSync(path.join(candidate, '.git'));
}

function registeredRepoPaths(registryPath: string): string[] {
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
      repos?: Array<{ localPath?: unknown }>;
    };
    return (registry.repos ?? [])
      .map((repo) => typeof repo.localPath === 'string' ? repo.localPath.trim() : '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve the checkout used by the QA runners and their preflight validator. */
export function resolveEvalRepoPath(declared: string): EvalRepoPathResolution {
  const declaredPath = declared.trim();
  const environmentPath = process.env.O8_EVAL_REPO_PATH?.trim() ?? '';
  const registryPath = path.join(os.homedir(), '.o8', 'repos.json');
  const attemptedPaths: string[] = [];

  if (environmentPath) {
    attemptedPaths.push(environmentPath);
    if (isGitCheckout(environmentPath)) {
      return {
        declaredPath,
        repoPath: environmentPath,
        source: 'environment',
        attemptedPaths,
        registryPath,
      };
    }
  }

  if (declaredPath) {
    attemptedPaths.push(declaredPath);
    if (isGitCheckout(declaredPath)) {
      return {
        declaredPath,
        repoPath: declaredPath,
        source: 'declared',
        attemptedPaths,
        registryPath,
      };
    }
  }

  for (const registeredPath of registeredRepoPaths(registryPath)) {
    if (!attemptedPaths.includes(registeredPath)) attemptedPaths.push(registeredPath);
    if (isGitCheckout(registeredPath)) {
      return {
        declaredPath,
        repoPath: registeredPath,
        source: 'registry',
        attemptedPaths,
        registryPath,
      };
    }
  }

  return {
    declaredPath,
    repoPath: declaredPath,
    source: 'unresolved',
    attemptedPaths,
    registryPath,
  };
}
