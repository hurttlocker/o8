import type { SupervisorInboxKind } from '@/lib/supervisor/inbox';

export type ProblemExposureDenominator =
  | 'distinct_reviewed_releases'
  | 'distinct_archived_lanes_with_recorded_endings';

const MISSING_ARCHIVE_ENDING = 'archived without a recorded ending';

const SENSOR_KINDS = new Set<SupervisorInboxKind>([
  'verification_failed',
  'bounded_retry_exhausted',
  'packet_no_changes',
]);

export function isProblemSensorKind(kind: SupervisorInboxKind): boolean {
  return SENSOR_KINDS.has(kind);
}

export function isEligibleProblemSignal(input: {
  kind: SupervisorInboxKind;
  errorExcerpt: string;
}): boolean {
  if (!isProblemSensorKind(input.kind)) return false;
  if (input.kind !== 'packet_no_changes') return true;
  return input.errorExcerpt.trim().toLowerCase() === MISSING_ARCHIVE_ENDING;
}

export function problemImpactBand(kind: SupervisorInboxKind): 'moderate' | 'high' {
  return kind === 'bounded_retry_exhausted' || kind === 'packet_no_changes'
    ? 'high'
    : 'moderate';
}

export function problemExposureDenominator(
  kind: SupervisorInboxKind,
): ProblemExposureDenominator {
  return kind === 'packet_no_changes'
    ? 'distinct_archived_lanes_with_recorded_endings'
    : 'distinct_reviewed_releases';
}

export function isRecordedArchiveEnding(outcome: string | null, note: string | null): boolean {
  if (!outcome) return false;
  return !(outcome === 'no_changes' && note?.trim().toLowerCase() === MISSING_ARCHIVE_ENDING);
}
