import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SupportedPackageManager } from './dependency-install';

const execFileAsync = promisify(execFile);

const MANAGER_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface ResolvedPackageManagerExecution {
  /** Absolute path of the executable that will run, never a PATH-resolved bare name. */
  executable: string;
  version: string;
}

/**
 * Absolute executable candidates for `manager`, in PATH order, without duplicates.
 * Relative PATH entries are skipped: they would resolve against the install cwd,
 * so they cannot name a stable executable for a receipt.
 */
export function packageManagerPathCandidates(
  manager: SupportedPackageManager,
  pathValue: string | undefined,
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const entry of (pathValue ?? '').split(path.delimiter)) {
    const directory = entry.trim();
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, manager);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

async function probeManagerVersion(executable: string): Promise<string | null> {
  try {
    await access(executable, constants.X_OK);
  } catch {
    return null;
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    }));
  } catch {
    return null;
  }
  const version = stdout.trim();
  return MANAGER_VERSION_PATTERN.test(version) ? version : null;
}

/**
 * Select the package-manager executable this repository supports.
 *
 * With a declared version (package.json `packageManager`), the first PATH entry
 * reporting exactly that version wins, so an older manager earlier on PATH cannot
 * silently materialize dependencies. Without a declaration the first usable entry
 * wins, matching the previous bare-name behaviour. Either way the returned absolute
 * path is what gets executed and receipted, so the probed version is the run version.
 */
export async function resolvePackageManagerExecution(
  manager: SupportedPackageManager,
  declaredVersion: string | null,
  pathValue: string | undefined = process.env.PATH,
): Promise<ResolvedPackageManagerExecution> {
  const observed: string[] = [];
  for (const candidate of packageManagerPathCandidates(manager, pathValue)) {
    const version = await probeManagerVersion(candidate);
    if (!version) continue;
    if (!declaredVersion || version === declaredVersion) return { executable: candidate, version };
    observed.push(`${candidate}@${version}`);
  }
  if (declaredVersion) {
    throw new Error(
      `No ${manager} ${declaredVersion} executable is on PATH for the declared package manager.`
      + ` Observed: ${observed.join(', ') || 'none'}`,
    );
  }
  throw new Error(`${manager} returned an invalid version.`);
}

/**
 * Pin execution to the exact manager version a dependency recipe receipts, so the
 * binary that runs is the binary that was measured. Callers that inject their own
 * version authority keep the previous bare-name invocation.
 */
export async function resolveReceiptedPackageManagerExecution(
  manager: SupportedPackageManager,
  receiptedVersion: string,
  injectedVersionAuthority: boolean,
): Promise<ResolvedPackageManagerExecution> {
  if (injectedVersionAuthority) return { executable: manager, version: receiptedVersion };
  const execution = await resolvePackageManagerExecution(manager, receiptedVersion);
  if (execution.version !== receiptedVersion) {
    throw new Error(`Selected ${manager} executable does not match its dependency recipe version.`);
  }
  return execution;
}
