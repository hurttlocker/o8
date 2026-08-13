import { describe, expect, it } from 'vitest';

import type { ProblemDossier } from './dossiers';
import { projectProblemDossierMetrics } from './metrics';

function dossier(overrides: Partial<ProblemDossier> = {}): ProblemDossier {
  return {
    schema: 'o8/problem-dossier/v1',
    id: 'problem-a',
    fingerprint: 'fingerprint-a',
    projectId: 'project-a',
    repoPath: '/repo',
    painStatement: 'verification failed: stable fixture',
    firstObservedAt: '2026-08-13T10:00:00.000Z',
    lastObservedAt: '2026-08-13T10:03:00.000Z',
    occurrenceCount: 3,
    observedDurationMs: 180_000,
    comparableExposureCount: 3,
    impactBand: 'moderate',
    evidenceConfidence: 'high',
    status: 'verified_closed',
    closureContract: {
      kind: 'supervisor_incident_absence',
      sourceKind: 'verification_failed',
      baseline: { occurrenceCount: 3, distinctAttempts: 3, recordedAt: '2026-08-13T10:03:00.000Z' },
      exposureDenominator: 'distinct_reviewed_releases',
      requiredComparableExposures: 3,
    },
    suppressedAt: null,
    cooldownUntil: null,
    acceptedAt: '2026-08-13T10:05:00.000Z',
    linkedTaskId: 'packet-a',
    provisionalResolvedAt: '2026-08-13T10:15:00.000Z',
    verifiedClosedAt: '2026-08-13T10:45:00.000Z',
    reopenedAt: null,
    operatorStoppedAt: null,
    suppressionReason: null,
    recurrenceProposalId: 'proposal-a',
    lastError: null,
    createdAt: '2026-08-13T10:03:00.000Z',
    updatedAt: '2026-08-13T10:45:00.000Z',
    evidence: [],
    history: [
      {
        id: 'event-candidate',
        dossierId: 'problem-a',
        eventType: 'candidate_promoted',
        actor: 'system',
        note: null,
        fromStatus: null,
        toStatus: 'candidate',
        at: '2026-08-13T10:03:00.000Z',
      },
      {
        id: 'event-accepted',
        dossierId: 'problem-a',
        eventType: 'remedy_accepted',
        actor: 'operator',
        note: null,
        fromStatus: 'candidate',
        toStatus: 'accepted',
        at: '2026-08-13T10:05:00.000Z',
      },
      {
        id: 'event-provisional',
        dossierId: 'problem-a',
        eventType: 'state_reconciled',
        actor: 'system',
        note: null,
        fromStatus: 'remedy_active',
        toStatus: 'provisionally_resolved',
        at: '2026-08-13T10:15:00.000Z',
      },
      {
        id: 'event-verified',
        dossierId: 'problem-a',
        eventType: 'verified_closed',
        actor: 'system',
        note: null,
        fromStatus: 'provisionally_resolved',
        toStatus: 'verified_closed',
        at: '2026-08-13T10:45:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('problem dossier measurements', () => {
  it('measures supported closure timings and names unavailable truth without inventing it', () => {
    const metrics = projectProblemDossierMetrics([dossier()]);
    expect(metrics).toMatchObject({
      schema: 'o8/problem-metrics/v1',
      population: { dossiers: 1, accepted: 1, verifiedClosed: 1 },
      detectionLatency: { samples: 1, averageMs: 180_000 },
      timeToRemedyRelease: { samples: 1, averageMs: 600_000 },
      timeToVerifiedClosure: { samples: 1, averageMs: 2_400_000 },
      comparableRecurrenceFreeExposures: 3,
      acceptedCandidatePrecision: { value: null },
      costPerVerifiedClosure: { value: null },
    });
  });
});
