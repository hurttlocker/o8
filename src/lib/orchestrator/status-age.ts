export const PENDING_APPROVAL_WARNING_MS = 24 * 60 * 60_000;

export function statusAgeLabel(ageMs: number | null): string {
  if (ageMs === null) return 'unknown';
  if (ageMs < 60_000) return '<1m';
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h`;
  return `${Math.floor(ageMs / 86_400_000)}d`;
}

export function approvalAge(createdAt: string | number | null | undefined, now = Date.now()) {
  const createdMs = typeof createdAt === 'number' ? createdAt
    : typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  const ageMs = Number.isFinite(createdMs) ? Math.max(0, now - createdMs) : null;
  return {
    ageMs,
    age: statusAgeLabel(ageMs),
    overdue: ageMs !== null && ageMs >= PENDING_APPROVAL_WARNING_MS,
    thresholdMs: PENDING_APPROVAL_WARNING_MS,
  };
}
