import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface HeadShaLockMatch {
  ok: true;
  expectedHeadSha?: string;
  currentHeadSha?: string;
}

export interface HeadShaLockMismatch {
  ok: false;
  expectedHeadSha: string;
  currentHeadSha: string;
}

export type HeadShaLockResult = HeadShaLockMatch | HeadShaLockMismatch;

export function normalizeHeadSha(value?: string | null) {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function isValidHeadSha(value?: string | null): boolean {
  const normalized = normalizeHeadSha(value);
  return normalized !== undefined && /^[0-9a-f]{7,40}$/i.test(normalized);
}

export async function readHeadSha(cwd: string) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    windowsHide: true,
    cwd,
    timeout: 5000,
  });
  return stdout.trim();
}

export async function resolveHeadSha(cwd: string, value: string): Promise<string | undefined> {
  const normalized = normalizeHeadSha(value);
  if (!isValidHeadSha(normalized)) return undefined;

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${normalized}^{commit}`], {
      windowsHide: true,
      cwd,
      timeout: 5000,
    });
    const resolved = stdout.trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export function headShaMatches(currentHeadSha: string, expectedHeadSha: string) {
  const current = normalizeHeadSha(currentHeadSha)?.toLowerCase();
  const expected = normalizeHeadSha(expectedHeadSha)?.toLowerCase();
  if (!current || !expected || !isValidHeadSha(current) || !isValidHeadSha(expected)) return false;
  return current === expected || current.startsWith(expected) || expected.startsWith(current);
}

export async function checkExpectedHeadSha(
  cwd: string,
  expectedHeadShaInput?: string | null,
): Promise<HeadShaLockResult> {
  const expectedHeadSha = normalizeHeadSha(expectedHeadShaInput);
  if (!expectedHeadSha) {
    return { ok: true };
  }

  const currentHeadSha = await readHeadSha(cwd);
  if (headShaMatches(currentHeadSha, expectedHeadSha)) {
    return { ok: true, expectedHeadSha, currentHeadSha };
  }

  return {
    ok: false,
    expectedHeadSha,
    currentHeadSha,
  };
}

export function formatHeadShaMismatchNote(result: HeadShaLockMismatch) {
  return `Worktree HEAD changed since review: expected ${result.expectedHeadSha}, current ${result.currentHeadSha}. Re-review before merging.`;
}
