import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-problem-dossiers-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const { getSqlite } = await import('@/lib/db');
const { enqueueInboxItem, listInboxItems } = await import('@/lib/supervisor/inbox');
const {
  listProblemDossiers,
  syncRecurringSupervisorProblems,
} = await import('@/lib/problems/dossiers');

function resetFixture(): void {
  listProblemDossiers({ includeSuppressed: true });
  listInboxItems({ includeAllProjects: true, includeDismissed: true });
  const sqlite = getSqlite();
  sqlite.exec(`
    DELETE FROM problem_remedies;
    DELETE FROM problem_evidence;
    DELETE FROM problem_dossiers;
    DELETE FROM supervisor_inbox;
  `);
}

function enqueueVerificationFailure(packetId: string, error: string): string {
  return enqueueInboxItem({
    repoPath: '/tmp/o8-problem-dossier-repo',
    packetId,
    kind: 'verification_failed',
    payload: {
      verificationKind: 'typecheck',
      error,
    },
  }).id;
}

describe('recurring problem dossiers', () => {
  it('collapses three matching packet incidents into one dossier with immutable evidence references', () => {
    resetFixture();
    const sourceIds = [
      enqueueVerificationFailure('pkt-alpha', 'src/example.ts:12:3 Type string is not assignable'),
      enqueueVerificationFailure('pkt-beta', 'src/example.ts:18:7 Type string is not assignable'),
      enqueueVerificationFailure('pkt-gamma', 'src/example.ts:41:2 Type string is not assignable'),
    ];

    const dossiers = listProblemDossiers({ includeSuppressed: true });

    expect(dossiers).toHaveLength(1);
    expect(dossiers[0]).toMatchObject({
      schema: 'o8/problem-dossier/v1',
      status: 'candidate',
      occurrenceCount: 3,
      comparableExposureCount: 0,
      impactBand: 'moderate',
      evidenceConfidence: 'high',
      closureContract: {
        kind: 'supervisor_incident_absence',
        sourceKind: 'verification_failed',
        baseline: {
          occurrenceCount: 3,
          distinctAttempts: 3,
        },
        exposureDenominator: 'distinct_reviewed_releases',
        requiredComparableExposures: 3,
      },
    });
    expect(dossiers[0]?.evidence.map((evidence) => evidence.sourceId).sort()).toEqual(sourceIds.sort());
    expect(dossiers[0]?.evidence.map((evidence) => evidence.packetId).sort()).toEqual([
      'pkt-alpha',
      'pkt-beta',
      'pkt-gamma',
    ]);
  });

  it('does not promote repeats from one packet or groups below the distinct-packet threshold', () => {
    resetFixture();
    enqueueVerificationFailure('pkt-single', 'Repeated failure');
    enqueueVerificationFailure('pkt-single', 'Repeated failure');
    enqueueVerificationFailure('pkt-other', 'Repeated failure');

    expect(listProblemDossiers({ includeSuppressed: true })).toEqual([]);
  });

  it('is idempotent and appends a later matching source without changing dossier identity', () => {
    resetFixture();
    enqueueVerificationFailure('pkt-one', 'Stable failure');
    enqueueVerificationFailure('pkt-two', 'Stable failure');
    enqueueVerificationFailure('pkt-three', 'Stable failure');
    const first = listProblemDossiers({ includeSuppressed: true })[0];

    const idempotent = syncRecurringSupervisorProblems({ now: new Date('2026-08-13T12:01:00.000Z') });
    enqueueVerificationFailure('pkt-four', 'Stable failure');
    const second = listProblemDossiers({ includeSuppressed: true })[0];

    expect(idempotent).toMatchObject({ qualifyingGroups: 1, createdDossierIds: [] });
    expect(second?.id).toBe(first?.id);
    expect(second?.occurrenceCount).toBe(4);
    expect(second?.evidence).toHaveLength(4);
  });

  it('keeps different failure shapes in separate dossiers', () => {
    resetFixture();
    for (const packetId of ['pkt-a1', 'pkt-a2', 'pkt-a3']) {
      enqueueVerificationFailure(packetId, 'Type string is not assignable');
    }
    for (const packetId of ['pkt-b1', 'pkt-b2', 'pkt-b3']) {
      enqueueVerificationFailure(packetId, 'Module cannot be resolved');
    }

    expect(listProblemDossiers({ includeSuppressed: true })).toHaveLength(2);
  });
});
