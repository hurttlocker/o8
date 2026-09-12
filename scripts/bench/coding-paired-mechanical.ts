import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface PairedCommandReceipt {
  command: string;
  status: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  stderrBytes: number;
  spawnErrorCode: string | null;
}

export interface PairedMechanicalReceipt {
  typecheck: PairedCommandReceipt;
  eslint: PairedCommandReceipt | null;
  lintedFiles: string[];
}

type RunCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => { receipt: PairedCommandReceipt; stdout: string; stderr: string };

export function pairedStagedDiffFacts(
  dir: string,
  diffPath: string,
  excludedArtifacts: string[],
): { changedFiles: string[]; additions: number; deletions: number } {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['reset', '-q', '--', ...excludedArtifacts], { cwd: dir });
  try {
    const diff = execFileSync('git', ['diff', '--cached', '--binary'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    fs.writeFileSync(diffPath, diff);
    const changedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: dir,
      encoding: 'utf8',
    }).split('\n').map((entry) => entry.trim()).filter(Boolean);
    const numstat = execFileSync('git', ['diff', '--cached', '--numstat'], {
      cwd: dir,
      encoding: 'utf8',
    });
    let additions = 0;
    let deletions = 0;
    for (const line of numstat.split('\n')) {
      const [added, deleted] = line.split('\t');
      if (/^\d+$/.test(added ?? '')) additions += Number(added);
      if (/^\d+$/.test(deleted ?? '')) deletions += Number(deleted);
    }
    return { changedFiles, additions, deletions };
  } finally {
    execFileSync('git', ['reset', '-q'], { cwd: dir });
  }
}

export function runPairedMechanicalChecks(
  dir: string,
  changedFiles: string[],
  runCommand: RunCommand,
): PairedMechanicalReceipt {
  const typecheck = runCommand('npx', ['tsc', '--noEmit'], {
    cwd: dir,
    timeoutMs: 10 * 60 * 1_000,
  }).receipt;
  const lintedFiles = changedFiles.filter((file) => (
    /\.(?:[cm]?[jt]sx?)$/.test(file) && fs.existsSync(path.join(dir, file))
  ));
  const eslint = lintedFiles.length > 0
    ? runCommand('npx', ['eslint', ...lintedFiles], {
        cwd: dir,
        timeoutMs: 10 * 60 * 1_000,
      }).receipt
    : null;
  return { typecheck, eslint, lintedFiles };
}
