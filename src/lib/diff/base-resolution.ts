import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isSafeGitRef } from '@/lib/git/refs';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export interface PacketDiffBaseResolution {
  baseBranch: string;
  requestedRef: string;
  comparisonRef: string;
  mergeBase: string | null;
  fetchedRemoteBase: boolean;
  usedFallback: boolean;
  warning: string | null;
}

function gitErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error || 'unknown git error');
}

async function gitStdout(cwd: string, args: string[], timeout = DEFAULT_FETCH_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  return stdout.trim();
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await gitStdout(cwd, ['rev-parse', '--verify', '--quiet', ref], 5_000);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePacketDiffBase(
  cwd: string,
  baseBranch: string,
  headSha: string,
  fetchTimeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<PacketDiffBaseResolution> {
  const base = baseBranch.trim() || 'main';
  if (!isSafeGitRef(base)) {
    throw new Error(`Unsafe base branch for diff: ${base}`);
  }

  const originRef = `origin/${base}`;
  let comparisonRef = base;
  let fetchedRemoteBase = false;
  let usedFallback = false;
  let warning: string | null = null;

  try {
    await gitStdout(cwd, ['fetch', 'origin', base, '--quiet'], fetchTimeoutMs);
    if (await refExists(cwd, originRef)) {
      comparisonRef = originRef;
      fetchedRemoteBase = true;
    } else {
      usedFallback = true;
      warning = `Fetched origin ${base}, but ${originRef} is unavailable; using local ${base}.`;
    }
  } catch (error) {
    usedFallback = true;
    warning = `Could not refresh ${originRef}: ${gitErrorMessage(error)}; using local ${base}.`;
  }

  let mergeBase: string | null = null;
  try {
    mergeBase = await gitStdout(cwd, ['merge-base', comparisonRef, headSha]);
  } catch (error) {
    usedFallback = true;
    warning = warning
      ? `${warning} merge-base failed for ${comparisonRef}: ${gitErrorMessage(error)}.`
      : `merge-base failed for ${comparisonRef}: ${gitErrorMessage(error)}.`;
  }

  return {
    baseBranch: base,
    requestedRef: originRef,
    comparisonRef,
    mergeBase,
    fetchedRemoteBase,
    usedFallback,
    warning,
  };
}
