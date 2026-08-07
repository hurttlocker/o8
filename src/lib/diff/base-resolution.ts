import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isSafeGitRef } from '@/lib/git/refs';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 4_000;
const FETCH_MEMO_TTL_MS = 60_000;

interface FetchOutcome {
  comparisonRef: string;
  fetchedRemoteBase: boolean;
  usedFallback: boolean;
  warning: string | null;
}

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
    windowsHide: true,
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

const fetchMemo = new Map<string, FetchOutcome & { attemptedAt: number }>();

export function resetPacketDiffBaseFetchMemoForTest(): void {
  fetchMemo.clear();
}

async function resolveFetchOutcome(
  cwd: string,
  base: string,
  originRef: string,
  fetchTimeoutMs: number,
): Promise<FetchOutcome> {
  const memoKey = `${cwd}\0${base}`;
  const cached = fetchMemo.get(memoKey);
  if (cached && Date.now() - cached.attemptedAt < FETCH_MEMO_TTL_MS) {
    return {
      comparisonRef: cached.comparisonRef,
      fetchedRemoteBase: cached.fetchedRemoteBase,
      usedFallback: cached.usedFallback,
      warning: cached.warning,
    };
  }

  let outcome: FetchOutcome;
  try {
    await gitStdout(cwd, ['fetch', 'origin', base, '--quiet'], fetchTimeoutMs);
    if (await refExists(cwd, originRef)) {
      outcome = {
        comparisonRef: originRef,
        fetchedRemoteBase: true,
        usedFallback: false,
        warning: null,
      };
    } else {
      outcome = {
        comparisonRef: base,
        fetchedRemoteBase: false,
        usedFallback: true,
        warning: `Fetched origin ${base}, but ${originRef} is unavailable; using local ${base}.`,
      };
    }
  } catch (error) {
    outcome = {
      comparisonRef: base,
      fetchedRemoteBase: false,
      usedFallback: true,
      warning: `Could not refresh ${originRef}: ${gitErrorMessage(error)}; using local ${base}.`,
    };
  }

  fetchMemo.set(memoKey, { ...outcome, attemptedAt: Date.now() });
  return outcome;
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
  const fetchOutcome = await resolveFetchOutcome(cwd, base, originRef, fetchTimeoutMs);
  let usedFallback = fetchOutcome.usedFallback;
  let warning = fetchOutcome.warning;

  let mergeBase: string | null = null;
  try {
    mergeBase = await gitStdout(cwd, ['merge-base', fetchOutcome.comparisonRef, headSha]);
  } catch (error) {
    usedFallback = true;
    warning = warning
      ? `${warning} merge-base failed for ${fetchOutcome.comparisonRef}: ${gitErrorMessage(error)}.`
      : `merge-base failed for ${fetchOutcome.comparisonRef}: ${gitErrorMessage(error)}.`;
  }

  return {
    baseBranch: base,
    requestedRef: originRef,
    comparisonRef: fetchOutcome.comparisonRef,
    mergeBase,
    fetchedRemoteBase: fetchOutcome.fetchedRemoteBase,
    usedFallback,
    warning,
  };
}
