import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface PairedDependencyPreparationReceipt {
  source: string;
  destination: string;
  method: 'apfs-copy-on-write-clone';
  owned: true;
  symbolicLink: false;
}

const validatedDependencySources = new Set<string>();

export function assertPairedDependencySource(repoRoot: string): string {
  const source = path.join(repoRoot, 'node_modules');
  if (validatedDependencySources.has(source)) return source;
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(source);
  } catch {
    throw new Error('node_modules is missing; prepare a known-good owned dependency clone before the benchmark');
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('node_modules must be an owned directory, not a symbolic link');
  }
  try {
    execFileSync(process.execPath, [
      '-e',
      "require('better-sqlite3')(':memory:').close()",
    ], { cwd: repoRoot, stdio: 'pipe' });
  } catch {
    throw new Error('node_modules failed the SQLite :memory: dependency check');
  }
  validatedDependencySources.add(source);
  return source;
}

function assertManagedPath(managedRoot: string, dir: string, expectedName: string): void {
  const resolvedRoot = path.resolve(managedRoot);
  const resolved = path.resolve(dir);
  const expected = path.join(resolvedRoot, expectedName);
  if (resolved !== expected || path.dirname(resolved) !== resolvedRoot || resolved === resolvedRoot) {
    throw new Error(`refusing unmanaged benchmark worktree path: ${dir}`);
  }
  if (fs.existsSync(resolved)) {
    throw new Error(`benchmark worktree already exists; preserve it and use a new run ID: ${resolved}`);
  }
}

function cloneDependencies(
  repoRoot: string,
  worktree: string,
): PairedDependencyPreparationReceipt {
  const source = assertPairedDependencySource(repoRoot);
  const destination = path.join(worktree, 'node_modules');
  if (fs.existsSync(destination)) {
    throw new Error(`benchmark worktree already contains dependencies: ${destination}`);
  }
  execFileSync('cp', ['-c', '-R', source, destination], { cwd: repoRoot });
  const destinationStat = fs.lstatSync(destination);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error(`benchmark dependencies are not an owned directory: ${destination}`);
  }
  return {
    source,
    destination,
    method: 'apfs-copy-on-write-clone',
    owned: true,
    symbolicLink: false,
  };
}

export function preparePairedDetachedWorktree(input: {
  repoRoot: string;
  managedRoot: string;
  dir: string;
  expectedName: string;
  base: string;
}): { path: string; dependencies: PairedDependencyPreparationReceipt } {
  assertManagedPath(input.managedRoot, input.dir, input.expectedName);
  execFileSync('git', ['worktree', 'add', '-q', '--detach', input.dir, input.base], {
    cwd: input.repoRoot,
  });
  return {
    path: input.dir,
    dependencies: cloneDependencies(input.repoRoot, input.dir),
  };
}

export function pairedWorkerName(
  runId: string,
  role: 'arm' | 'judge',
  task: number,
  condition: string,
): string {
  const readableRunId = runId.replace(/[^a-z0-9-]/gi, '-').slice(0, 24);
  const runIdHash = createHash('sha256').update(runId).digest('hex').slice(0, 16);
  const safeCondition = condition.replace(/[^a-z0-9_-]/gi, '-');
  return `bc-${readableRunId}-${runIdHash}-${role}-${task}-${safeCondition}`;
}
