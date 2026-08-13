import type { ProblemDossier, ProblemDossierEvent } from './dossiers';

export const PROBLEM_METRICS_SCHEMA = 'o8/problem-metrics/v1' as const;

export interface ProblemRateMetric {
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface ProblemDurationMetric {
  samples: number;
  averageMs: number | null;
  minimumMs: number | null;
  maximumMs: number | null;
}

export interface ProblemUnavailableMetric {
  value: null;
  reason: string;
}

export interface ProblemDossierMetrics {
  schema: typeof PROBLEM_METRICS_SCHEMA;
  population: {
    dossiers: number;
    accepted: number;
    suppressed: number;
    provisional: number;
    verifiedClosed: number;
    reopened: number;
  };
  acceptedCandidatePrecision: ProblemUnavailableMetric;
  suppressionRate: ProblemRateMetric;
  falseClosureReopenRate: ProblemRateMetric;
  detectionLatency: ProblemDurationMetric;
  timeToRemedyRelease: ProblemDurationMetric;
  timeToVerifiedClosure: ProblemDurationMetric;
  comparableRecurrenceFreeExposures: number;
  timeToCredibleRootCauseHypothesis: ProblemUnavailableMetric;
  operatorInterventionsPerVerifiedRemedy: ProblemUnavailableMetric;
  costPerVerifiedClosure: ProblemUnavailableMetric;
}

function rate(numerator: number, denominator: number): ProblemRateMetric {
  return {
    numerator,
    denominator,
    value: denominator > 0 ? numerator / denominator : null,
  };
}

function duration(samples: number[]): ProblemDurationMetric {
  if (samples.length === 0) {
    return { samples: 0, averageMs: null, minimumMs: null, maximumMs: null };
  }
  return {
    samples: samples.length,
    averageMs: Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    minimumMs: Math.min(...samples),
    maximumMs: Math.max(...samples),
  };
}

function elapsed(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
}

function eventAt(
  events: ProblemDossierEvent[],
  predicate: (event: ProblemDossierEvent) => boolean,
  after?: string,
): string | null {
  return events.find((event) => (!after || event.at >= after) && predicate(event))?.at ?? null;
}

function cycleDurations(
  dossier: ProblemDossier,
  endPredicate: (event: ProblemDossierEvent) => boolean,
): number[] {
  return dossier.history
    .filter((event) => event.eventType === 'remedy_accepted')
    .map((accepted) => elapsed(accepted.at, eventAt(dossier.history, endPredicate, accepted.at)))
    .filter((value): value is number => value !== null);
}

export function projectProblemDossierMetrics(dossiers: ProblemDossier[]): ProblemDossierMetrics {
  const accepted = dossiers.filter((dossier) => dossier.acceptedAt !== null).length;
  const suppressed = dossiers.filter((dossier) => (
    dossier.history.some((event) => event.eventType === 'suppressed') && dossier.acceptedAt === null
  )).length;
  const closureEvaluated = dossiers.filter((dossier) => dossier.history.some((event) => (
    event.toStatus === 'provisionally_resolved' || event.toStatus === 'verified_closed'
  )));
  const reopened = closureEvaluated.filter((dossier) => (
    dossier.history.some((event) => event.eventType === 'recurrence_reopened')
  )).length;
  const detectionDurations = dossiers
    .map((dossier) => elapsed(
      dossier.firstObservedAt,
      eventAt(dossier.history, (event) => event.eventType === 'candidate_promoted'),
    ))
    .filter((value): value is number => value !== null);
  const releaseDurations = dossiers.flatMap((dossier) => cycleDurations(
    dossier,
    (event) => event.toStatus === 'provisionally_resolved',
  ));
  const closureDurations = dossiers.flatMap((dossier) => cycleDurations(
    dossier,
    (event) => event.eventType === 'verified_closed',
  ));

  return {
    schema: PROBLEM_METRICS_SCHEMA,
    population: {
      dossiers: dossiers.length,
      accepted,
      suppressed,
      provisional: dossiers.filter((dossier) => dossier.status === 'provisionally_resolved').length,
      verifiedClosed: dossiers.filter((dossier) => dossier.status === 'verified_closed').length,
      reopened: dossiers.filter((dossier) => dossier.status === 'reopened').length,
    },
    acceptedCandidatePrecision: {
      value: null,
      reason: 'Precision requires operator-labeled true and false candidates; acceptance alone is not ground truth.',
    },
    suppressionRate: rate(suppressed, accepted + suppressed),
    falseClosureReopenRate: rate(reopened, closureEvaluated.length),
    detectionLatency: duration(detectionDurations),
    timeToRemedyRelease: duration(releaseDurations),
    timeToVerifiedClosure: duration(closureDurations),
    comparableRecurrenceFreeExposures: dossiers.reduce(
      (sum, dossier) => sum + dossier.comparableExposureCount,
      0,
    ),
    timeToCredibleRootCauseHypothesis: {
      value: null,
      reason: 'The first slice has no durable root-cause hypothesis decision yet.',
    },
    operatorInterventionsPerVerifiedRemedy: {
      value: null,
      reason: 'Mission Funnel intervention attribution is not yet projected into the dossier measurement record.',
    },
    costPerVerifiedClosure: {
      value: null,
      reason: 'Mission cost is not yet snapshotted at the dossier closure boundary.',
    },
  };
}
