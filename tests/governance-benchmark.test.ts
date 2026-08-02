import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  loadGovernanceFixtures,
  scoreGovernanceResults,
  type GovernanceReviewResult,
} from '../scripts/bench/governance';
import type { HarnessEvaluationResult } from '../src/lib/harness/types';

function evaluation(
  verdict: HarnessEvaluationResult['verdict'],
  detail: string,
  hasFinding = verdict === 'request_changes',
): HarnessEvaluationResult {
  return {
    schema: 'o8/evaluate-diff/v1',
    verdict,
    summary: detail,
    findings: hasFinding ? [{
      severity: 'high',
      file: 'src/example.ts',
      line: 1,
      title: detail,
      detail,
    }] : [],
    risk: 'standard',
    riskReasons: [],
    reviewerBackend: 'test',
    reviewedAt: 1,
  };
}

describe('governance benchmark fixtures', () => {
  it('keeps three planted diffs and two clean controls as re-applicable patch files', () => {
    const fixtures = loadGovernanceFixtures();

    expect(fixtures.filter((fixture) => fixture.groundTruth.classification === 'planted')).toHaveLength(3);
    expect(fixtures.filter((fixture) => fixture.groundTruth.classification === 'clean')).toHaveLength(2);
    for (const fixture of fixtures) {
      expect(fixture.id).toMatch(/^case-\d{2}$/);
      expect(fs.readFileSync(fixture.patchPath, 'utf8')).toMatch(/^diff --git /);
    }
  });

  it('scores only a matching planted finding as a catch and any clean finding as a false positive', () => {
    const fixtures = loadGovernanceFixtures();
    const planted = fixtures.find((fixture) => fixture.id === 'case-02')!;
    const cleanWithFinding = fixtures.find((fixture) => fixture.id === 'case-04')!;
    const cleanWithoutFinding = fixtures.find((fixture) => fixture.id === 'case-05')!;
    const results: GovernanceReviewResult[] = [
      {
        neutralLabel: 'input-01',
        fixture: planted,
        evaluation: evaluation('request_changes', 'Retry attempts make a duplicate ledger entry for the event id.'),
      },
      {
        neutralLabel: 'input-02',
        fixture: cleanWithFinding,
        evaluation: evaluation('approve', 'The ownership guard should move to another file.', true),
      },
      {
        neutralLabel: 'input-03',
        fixture: cleanWithoutFinding,
        evaluation: evaluation('approve', 'The retry ledger is correct.'),
      },
    ];

    expect(scoreGovernanceResults(results)).toEqual({
      catch: { caught: 1, total: 1, rate: 1 },
      falsePositive: { flagged: 1, total: 2, rate: 0.5 },
      inconclusive: 0,
    });
  });
});
