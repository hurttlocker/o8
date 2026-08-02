/**
 * Real-path tests for the task-contract coverage gate.
 *
 * The claim under test is not "the helper works" — it is that an
 * approved-LOOKING review cannot authorize a merge when coverage is incomplete.
 * So these drive `evaluateContractCoverage` with the shapes a real review
 * actually produces, including the ones that would silently pass a softer gate.
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateContractCoverage,
  readCoverageEvidence,
  type ReviewCoverageEvidence,
} from '@/lib/orchestrator/task-contract-coverage';
import { normalizeQualitySearchPacketState } from '@/lib/orchestrator/quality-search';
import type { PacketTaskContract } from '@/lib/orchestrator/types';

const HEAD = 'a'.repeat(40);

const contract: PacketTaskContract = {
  version: 1,
  requirements: [
    {
      id: 'R1',
      source: 'Reject an actor who is not the repository owner.',
      expectedBehavior: 'Publication rejects a non-owner actor.',
      productionPath: 'src/lib/publish.ts',
      verification: 'unit + route test',
    },
    {
      id: 'R2',
      source: 'Retry must not duplicate ledger entries.',
      expectedBehavior: 'A retried write produces one row.',
      productionPath: 'src/lib/ledger.ts',
      verification: 'integration test',
    },
  ],
  smallestRoute: [],
  exclusions: [],
};

function evidence(overrides: Partial<ReviewCoverageEvidence> = {}): ReviewCoverageEvidence {
  return {
    contractVersion: 1,
    headSha: HEAD,
    entries: [
      { requirementId: 'R1', productionPath: 'src/lib/publish.ts' },
      { requirementId: 'R2', productionPath: 'src/lib/ledger.ts' },
    ],
    ...overrides,
  };
}

const CHANGED = ['src/lib/publish.ts', 'src/lib/ledger.ts'];

describe('task-contract coverage gate', () => {
  it('passes when every sealed requirement cites a path the change touched', () => {
    const result = evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: evidence(),
      reviewedHeadSha: HEAD,
      changedPaths: CHANGED,
    });
    expect(result.status).toBe('passed');
    expect(result.missingRequirementIds).toEqual([]);
  });

  it('fails and names the exact requirement when one is unevidenced', () => {
    const result = evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: evidence({ entries: [{ requirementId: 'R1', productionPath: 'src/lib/publish.ts' }] }),
      reviewedHeadSha: HEAD,
      changedPaths: CHANGED,
    });
    expect(result.status).toBe('failed');
    // The selector's targeted repair depends on getting the exact id back.
    expect(result.missingRequirementIds).toEqual(['R2']);
    expect(result.checks.find((c) => c.requirementId === 'R2')?.failureReason)
      .toBe('requirement-not-evidenced');
  });

  it('rejects evidence citing a file the change never touched', () => {
    const result = evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: evidence({
        entries: [
          { requirementId: 'R1', productionPath: 'src/lib/publish.ts' },
          { requirementId: 'R2', productionPath: 'src/lib/somewhere-else.ts' },
        ],
      }),
      reviewedHeadSha: HEAD,
      changedPaths: CHANGED,
    });
    expect(result.status).toBe('failed');
    expect(result.checks.find((c) => c.requirementId === 'R2')?.failureReason)
      .toBe('cited-path-not-in-change');
  });

  it('rejects evidence gathered at a different commit than the review authorizes', () => {
    const result = evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: evidence({ headSha: 'b'.repeat(40) }),
      reviewedHeadSha: HEAD,
      changedPaths: CHANGED,
    });
    expect(result.status).toBe('failed');
    expect(result.checks.every((c) => c.failureReason === 'evidence-head-mismatch')).toBe(true);
  });

  it('rejects evidence produced against a superseded contract version', () => {
    const result = evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: evidence({ contractVersion: 0 }),
      reviewedHeadSha: HEAD,
      changedPaths: CHANGED,
    });
    expect(result.status).toBe('failed');
    expect(result.checks.every((c) => c.failureReason === 'contract-version-mismatch')).toBe(true);
  });

  it('fails closed when a contract is required but absent', () => {
    const result = evaluateContractCoverage({
      contract: null,
      contractRequired: true,
      evidence: evidence(),
      reviewedHeadSha: HEAD,
      changedPaths: CHANGED,
    });
    expect(result.status).toBe('failed');
  });

  it('fails when no evidence was recorded at all — the shape a softer gate would pass', () => {
    const result = evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: null,
      reviewedHeadSha: HEAD,
      changedPaths: CHANGED,
    });
    expect(result.status).toBe('failed');
    expect(result.checks.every((c) => c.failureReason === 'no-evidence-recorded')).toBe(true);
    expect(result.missingRequirementIds).toEqual(['R1', 'R2']);
  });

  it('leaves legacy packets untouched', () => {
    for (const contractRequired of [undefined, null, false] as const) {
      const result = evaluateContractCoverage({
        contract: null,
        contractRequired,
        evidence: null,
        reviewedHeadSha: HEAD,
        changedPaths: [],
      });
      expect(result.status).toBe('not-applicable');
      expect(result.missingRequirementIds).toEqual([]);
    }
  });

  it('reads evidence off untyped approval args and rejects malformed shapes', () => {
    expect(readCoverageEvidence({ contractCoverageEvidence: evidence() })?.entries).toHaveLength(2);
    expect(readCoverageEvidence({})).toBeNull();
    expect(readCoverageEvidence({ contractCoverageEvidence: { contractVersion: '1' } })).toBeNull();
    expect(readCoverageEvidence(null)).toBeNull();
    // An entry missing productionPath must not count toward coverage.
    const partial = readCoverageEvidence({
      contractCoverageEvidence: {
        contractVersion: 1,
        headSha: HEAD,
        entries: [{ requirementId: 'R1' }, { requirementId: 'R2', productionPath: 'src/lib/ledger.ts' }],
      },
    });
    expect(partial?.entries.map((e) => e.requirementId)).toEqual(['R2']);
  });
});

describe('coverage evidence survives the selection round-trip', () => {
  const baseCandidate = {
    packetId: 'p1',
    role: 'minimal_complete',
    headSha: HEAD,
    diffFingerprint: 'f',
    taskContractFingerprint: 't',
    requirementCount: 2,
    contractCoveragePassed: true,
    reviewApproved: true,
    reviewPinnedToHead: true,
    mergeGatePassed: true,
    failedChecks: [],
    changedFiles: 1,
    additions: 1,
    deletions: 0,
    newPublicSurfaces: 0,
  };

  function roundTrip(candidate: Record<string, unknown>) {
    // Driven through the exported entry point selection actually uses, not the
    // private normalizer — a field can only be trusted if it survives this path.
    const state = normalizeQualitySearchPacketState({
      version: 1,
      role: 'minimal_complete',
      repairAttempts: 0,
      receipt: {
        version: 1,
        createdAt: new Date(0).toISOString(),
        outcome: 'repair',
        reason: 'coverage incomplete',
        candidates: [candidate],
      },
    });
    return state?.receipt?.candidates[0];
  }

  it('normalizes absent coverage to unknown, never to passed', () => {
    const normalized = roundTrip(baseCandidate);
    expect(normalized?.contractCoverageStatus).toBe('unknown');
    expect(normalized?.missingRequirementIds).toEqual([]);
  });

  it('carries the exact missing requirement ids through to repair feedback', () => {
    const normalized = roundTrip({
      ...baseCandidate,
      contractCoverageStatus: 'failed',
      missingRequirementIds: ['R2', ''],
      coverageFailureReasons: ['cited-path-not-in-change', 42],
    });
    expect(normalized?.contractCoverageStatus).toBe('failed');
    expect(normalized?.missingRequirementIds).toEqual(['R2']);
    expect(normalized?.coverageFailureReasons).toEqual(['cited-path-not-in-change']);
  });

  it('keeps a coverage failure distinguishable from a rejected review', () => {
    const coverageFailure = roundTrip({
      ...baseCandidate,
      reviewApproved: true,
      contractCoverageStatus: 'failed',
      missingRequirementIds: ['R2'],
    });
    const rejectedReview = roundTrip({
      ...baseCandidate,
      reviewApproved: false,
      contractCoverageStatus: 'not-applicable',
      missingRequirementIds: [],
    });
    // Same boolean would have collapsed these two into one signal.
    expect(coverageFailure?.reviewApproved).toBe(true);
    expect(coverageFailure?.contractCoverageStatus).toBe('failed');
    expect(rejectedReview?.reviewApproved).toBe(false);
    expect(rejectedReview?.contractCoverageStatus).toBe('not-applicable');
  });
});
