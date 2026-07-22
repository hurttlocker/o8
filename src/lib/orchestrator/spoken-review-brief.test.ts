import { describe, expect, it } from 'vitest';
import { buildSpokenReviewBrief } from './spoken-review-brief';

describe('buildSpokenReviewBrief', () => {
  it('speaks renamed-away API and migration surfaces by their previous paths', () => {
    const brief = buildSpokenReviewBrief({
      packetId: 'packet-renames',
      title: 'Surface move',
      evidence: {
        headSha: 'a'.repeat(40),
        fingerprint: 'b'.repeat(64),
        diffBase: 'main',
        stat: '2 files changed',
      },
      fileChanges: [
        { status: 'renamed', previousPath: 'src/app/api/users/route.ts', path: 'src/lib/users.ts' },
        { status: 'renamed', previousPath: 'db/migrations/001.sql', path: 'archive/001.sql' },
      ],
      review: { verdict: 'approved', summary: 'Reviewed.', findings: [] },
      mergeGate: { verdict: 'passing', checks: [] },
      secondPass: { status: 'not-required' },
    });

    expect(brief.files.apiSurface).toContain('src/app/api/users/route.ts');
    expect(brief.files.migrations).toContain('db/migrations/001.sql');
    expect(brief.spokenSummary).toContain('1 migration or schema path');
    expect(brief.spokenSummary).toContain('1 API or command surface');
  });

  it('summarizes review evidence without diff hunks', () => {
    const brief = buildSpokenReviewBrief({
      packetId: 'pkt-1218',
      title: 'Spoken review',
      evidence: { headSha: 'abc123', fingerprint: 'diff123', diffBase: 'base123', stat: '3 files changed' },
      fileChanges: [
        { path: 'src/app/api/things/route.ts', status: 'modified' },
        { path: 'src/lib/db/migrations/0042.sql', status: 'added' },
        { path: 'src/removed.ts', status: 'deleted' },
      ],
      review: {
        verdict: 'rejected',
        summary: 'Changes requested.',
        findings: [{
          file: 'src/app/api/things/route.ts',
          line: 19,
          severity: 'high',
          description: 'The route misses authorization.',
          resolution: 'deferred',
        }],
      },
      approvalRisk: 'high',
      reviewRiskReasons: ['path-glob: database code or schema state'],
      mergeGate: {
        verdict: 'failing',
        checks: [{ name: 'security-patterns', verdict: 'fail', detail: 'eval() usage' }],
      },
      secondPass: { status: 'blocked', detail: 'Reviewer disagreed at route.ts:19.' },
      testEvidence: {
        current: true,
        selfReview: {
          passed: false,
          confidence: 'low',
          summary: 'Vitest failed in the route suite.',
        },
      },
    });

    expect(brief.files.deleted).toEqual(['src/removed.ts']);
    expect(brief.files.migrations).toEqual(['src/lib/db/migrations/0042.sql']);
    expect(brief.files.apiSurface).toEqual(['src/app/api/things/route.ts']);
    expect(brief.secondPass.status).toBe('blocked');
    expect(brief.tests.status).toBe('worker-reported-failed');
    expect(brief.riskFlags).toContain('path-glob: database code or schema state');
    expect(brief.spokenSummary).toContain('The AI review rejected with 1 finding');
    expect(brief.spokenSummary).not.toContain('@@');
  });

  it('states when review and tests have not been recorded', () => {
    const brief = buildSpokenReviewBrief({
      packetId: 'pkt-empty',
      title: 'Empty packet',
      evidence: { headSha: 'abc123', fingerprint: 'diff123', diffBase: 'base123', stat: '' },
      fileChanges: [],
      review: { verdict: 'unreviewed', summary: '', findings: [] },
      mergeGate: { verdict: 'unavailable', checks: [] },
      secondPass: { status: 'not-required' },
    });

    expect(brief.tests.status).toBe('not-reported');
    expect(brief.spokenSummary).toContain('no detected file changes');
    expect(brief.spokenSummary).toContain('has not recorded a verdict');
    expect(brief.spokenSummary).toContain('No test result was recorded');
  });

  it('does not turn skipped tests into a passing result', () => {
    const brief = buildSpokenReviewBrief({
      packetId: 'pkt-skipped',
      title: 'Skipped tests',
      evidence: { headSha: 'abc123', fingerprint: 'diff123', diffBase: 'base123', stat: '1 file changed' },
      fileChanges: [{ path: 'src/example.ts', status: 'modified' }],
      review: { verdict: 'approved', summary: 'Approved.', findings: [] },
      mergeGate: { verdict: 'passing', checks: [] },
      secondPass: { status: 'not-required' },
      testEvidence: {
        current: true,
        selfReview: {
          passed: true,
          confidence: 'medium',
          summary: 'Tests skipped because the fixture was unavailable.',
        },
      },
    });

    expect(brief.tests.status).toBe('not-reported');
    expect(brief.spokenSummary).toContain('No test result was recorded');
  });

  it('does not infer a pass from a self-review that only says tests were added', () => {
    const brief = buildSpokenReviewBrief({
      packetId: 'pkt-added-tests',
      title: 'Added tests',
      evidence: { headSha: 'abc123', fingerprint: 'diff123', diffBase: 'base123', stat: '1 file changed' },
      fileChanges: [{ path: 'src/example.test.ts', status: 'added' }],
      review: { verdict: 'approved', summary: 'Approved.', findings: [] },
      mergeGate: { verdict: 'passing', checks: [] },
      secondPass: { status: 'not-required' },
      testEvidence: {
        current: true,
        selfReview: {
          passed: true,
          confidence: 'high',
          summary: 'Added tests for the spoken review route.',
        },
      },
    });

    expect(brief.tests.status).toBe('not-reported');
  });

  it.each([
    'No tests passed.',
    'The tests are not passing.',
  ])('treats a negated pass as failed: %s', (summary) => {
    const brief = buildSpokenReviewBrief({
      packetId: 'pkt-negated-tests',
      title: 'Negated tests',
      evidence: { headSha: 'abc123', fingerprint: 'diff123', diffBase: 'base123', stat: '1 file changed' },
      fileChanges: [{ path: 'src/example.test.ts', status: 'modified' }],
      review: { verdict: 'approved', summary: 'Approved.', findings: [] },
      mergeGate: { verdict: 'passing', checks: [] },
      secondPass: { status: 'not-required' },
      testEvidence: {
        current: true,
        selfReview: { passed: false, confidence: 'high', summary },
      },
    });

    expect(brief.tests.status).toBe('worker-reported-failed');
  });

  it('marks completion evidence from another attempt or HEAD as stale', () => {
    const brief = buildSpokenReviewBrief({
      packetId: 'pkt-stale',
      title: 'Stale tests',
      evidence: { headSha: 'new-head', fingerprint: 'diff-new', diffBase: 'base123', stat: '1 file changed' },
      fileChanges: [{ path: 'src/example.ts', status: 'modified' }],
      review: { verdict: 'approved', summary: 'Approved.', findings: [] },
      mergeGate: { verdict: 'passing', checks: [] },
      secondPass: { status: 'not-required' },
      testEvidence: {
        current: false,
        selfReview: {
          passed: true,
          confidence: 'high',
          summary: 'Vitest passed.',
        },
      },
    });

    expect(brief.tests.status).toBe('stale');
    expect(brief.spokenSummary).toContain('earlier attempt or HEAD');
  });
});
