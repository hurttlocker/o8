export const FIRST_MERGE_CELEBRATION_STORAGE_KEY = 'cortex-ftux-first-merge-celebrated';
export const FIRST_MERGE_CELEBRATION_DURATION_MS = 4_000;
export const FIRST_MERGE_CELEBRATION_MESSAGE = 'Your first agent merge is live. Welcome to autonomous engineering.';

export interface FirstMergeCelebrationPayload {
  workspaceId: string;
  repo: string;
  repoPath: string;
  branch: string;
  sessionKey: string;
  prNumber: number | null;
  prTitle: string;
  prUrl: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  durationMs: number | null;
  mergedAt: number;
}

export interface FirstMergeCelebrationState extends FirstMergeCelebrationPayload {
  startedAt: number;
  endsAt: number;
}

export function buildFirstMergeCelebrationState(
  payload: FirstMergeCelebrationPayload,
  startedAt = Date.now(),
): FirstMergeCelebrationState {
  return {
    ...payload,
    startedAt,
    endsAt: startedAt + FIRST_MERGE_CELEBRATION_DURATION_MS,
  };
}

export function formatCelebrationDuration(durationMs: number | null): string | null {
  if (!Number.isFinite(durationMs) || durationMs === null || durationMs < 0) return null;

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

export function formatCelebrationLineDelta(additions: number, deletions: number): string {
  return `+${Math.max(0, additions).toLocaleString()} -${Math.max(0, deletions).toLocaleString()}`;
}

export function readFirstMergeCelebrated() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(FIRST_MERGE_CELEBRATION_STORAGE_KEY) === '1';
}

export function markFirstMergeCelebrated() {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(FIRST_MERGE_CELEBRATION_STORAGE_KEY, '1');
}
