import { describe, expect, it } from 'vitest';

import {
  fingerprintQualitySearchContract,
  selectQualitySearchCandidate,
  type QualitySearchCandidateEvidence,
} from '@/lib/orchestrator/quality-search';

const contract = {
  version: 1 as const,
  requirements: [{
    id: 'R1',
    source: 'Keep the real route covered.',
    expectedBehavior: 'The route returns the requested result.',
    productionPath: 'route -> service',
    verification: 'focused route test',
  }],
  smallestRoute: [{
    path: 'src/route.ts',
    requirements: ['R1'],
    reason: 'The route owns the behavior.',
  }],
  exclusions: [],
};

const contractFingerprint = fingerprintQualitySearchContract(contract);

function evidence(overrides: Partial<QualitySearchCandidateEvidence>): QualitySearchCandidateEvidence {
  return {
    packetId: 'pkt-a',
    role: 'minimal_complete',
    headSha: 'a'.repeat(40),
    diffFingerprint: 'diff-a',
    taskContractFingerprint: contractFingerprint,
    requirementCount: 1,
    contractCoverageStatus: 'passed' as const,
  missingRequirementIds: [] as string[],
  coverageFailureReasons: [] as string[],
  contractCoveragePassed: true,
    reviewApproved: true,
    reviewPinnedToHead: true,
    mergeGatePassed: true,
    failedChecks: [],
    changedFiles: 2,
    additions: 20,
    deletions: 4,
    newPublicSurfaces: 0,
    ...overrides,
  };
}

describe('quality-search candidate selection', () => {
  it('filters incomplete candidates before considering minimality', () => {
    const result = selectQualitySearchCandidate({
      createdAt: '2026-08-02T12:00:00.000Z',
      repairAttempts: 0,
      candidates: [
        evidence({
          packetId: 'small-but-incomplete',
          changedFiles: 1,
          additions: 2,
          contractCoveragePassed: false,
        }),
        evidence({
          packetId: 'larger-complete',
          role: 'robustness_complete',
          changedFiles: 5,
          additions: 80,
        }),
      ],
    });

    expect(result.outcome).toBe('selected');
    expect(result.selectedPacketId).toBe('larger-complete');
  });

  it('uses blast radius only when both candidates are complete', () => {
    const result = selectQualitySearchCandidate({
      repairAttempts: 0,
      candidates: [
        evidence({ packetId: 'small', changedFiles: 2, additions: 20 }),
        evidence({
          packetId: 'large',
          role: 'robustness_complete',
          changedFiles: 4,
          additions: 50,
        }),
      ],
    });

    expect(result.outcome).toBe('selected');
    expect(result.selectedPacketId).toBe('small');
  });

  it('grants one targeted repair, then holds instead of choosing an incomplete winner', () => {
    const candidates = [
      evidence({ packetId: 'closer', mergeGatePassed: false, failedChecks: ['diff-budget'] }),
      evidence({
        packetId: 'farther',
        role: 'robustness_complete',
        reviewApproved: false,
        reviewPinnedToHead: false,
        mergeGatePassed: false,
        failedChecks: ['contract-coverage', 'self-review-integrity'],
      }),
    ];

    const repair = selectQualitySearchCandidate({ candidates, repairAttempts: 0 });
    expect(repair.outcome).toBe('repair');
    expect(repair.repairPacketId).toBe('closer');

    const hold = selectQualitySearchCandidate({ candidates, repairAttempts: 1 });
    expect(hold.outcome).toBe('hold');
    expect(hold.selectedPacketId).toBeNull();
  });

  it('holds when candidates do not share the same sealed contract', () => {
    const result = selectQualitySearchCandidate({
      repairAttempts: 0,
      candidates: [
        evidence({ packetId: 'a' }),
        evidence({
          packetId: 'b',
          role: 'robustness_complete',
          taskContractFingerprint: 'different',
        }),
      ],
    });

    expect(result.outcome).toBe('hold');
    expect(result.receipt.reason).toContain('identical sealed task contract');
  });
});
