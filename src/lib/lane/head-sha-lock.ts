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

export async function readHeadSha(cwd: string) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    windowsHide: true,
    cwd,
    timeout: 5000,
  });
  return stdout.trim();
}

function headShaMatches(currentHeadSha: string, expectedHeadSha: string) {
  return currentHeadSha === expectedHeadSha || currentHeadSha.startsWith(expectedHeadSha);
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
