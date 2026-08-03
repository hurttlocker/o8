import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CODING_CONDITIONS,
  CODING_JUDGES,
  type CodingCondition,
  type CodingJudge,
  type CodingTask,
  type CodingVerdict,
  scoreCodingResults,
} from '../../scripts/bench/coding';
import {
  CODING_TASK_CONTRACT_FILE,
  readCodingTaskContract,
} from '../../scripts/bench/coding-task-contract';
import {
  assertEndToEndDiffIsBlind,
  blindEndToEndDiff,
  endToEndMeasurementNotes,
  scoreEndToEndResults,
  type EndToEndCondition,
} from '../../scripts/bench/coding-end-to-end';

const task: CodingTask = { issue: 1, base: 'base', label: 'one' };
const mapping = Object.fromEntries(CODING_CONDITIONS.map((condition, index) => (
  [String.fromCharCode(65 + index), condition]
))) as Record<string, CodingCondition>;

function verdict(condition: CodingCondition, judge: CodingJudge, total: number): CodingVerdict {
  const blindLabel = Object.entries(mapping).find(([, value]) => value === condition)?.[0] ?? '';
  return {
    task: task.issue,
    blindLabel,
    judge,
    subScores: {
      correctness: total,
      scopeDiscipline: total,
      robustness: total,
      fit: total,
    },
    total,
    mostSeriousDefect: '',
  };
}

describe('coding benchmark hardening', () => {
  it('reports a missing or malformed contract artifact as absent', () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-contract-'));
    try {
      expect(readCodingTaskContract(worktree)).toBeNull();
      fs.writeFileSync(path.join(worktree, CODING_TASK_CONTRACT_FILE), '{not json}\n');
      expect(readCodingTaskContract(worktree)).toBeNull();

      fs.writeFileSync(path.join(worktree, CODING_TASK_CONTRACT_FILE), JSON.stringify({
        version: 1,
        requirements: [{
          id: 'R1',
          source: 'write a durable contract artifact',
          expectedBehavior: 'the artifact survives worker transport',
          productionPath: 'scripts/bench/run-coding.ts',
          verification: 'read and parse task-contract.json',
        }],
        smallestRoute: [{
          path: 'scripts/bench/run-coding.ts',
          requirements: ['R1'],
          reason: 'the collection runner owns arm validation',
        }],
        exclusions: [],
      }));
      expect(readCodingTaskContract(worktree)?.requirements.map((requirement) => requirement.id)).toEqual(['R1']);
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('blocks a decisive win when the judges disagree on its direction', () => {
    const judgeScores: Record<CodingCondition, Record<CodingJudge, number>> = {
      'codex-raw': { codex: 9, claude: 2 },
      'codex-contract': { codex: 7, claude: 8 },
      'claude-raw': { codex: 4, claude: 4 },
      'claude-contract': { codex: 5, claude: 5 },
    };
    const verdicts = CODING_CONDITIONS.flatMap((condition) => (
      CODING_JUDGES.map((judge) => verdict(condition, judge, judgeScores[condition][judge]))
    ));

    const summary = scoreCodingResults([task], verdicts, { [task.issue]: mapping });
    const result = summary.results[0];

    expect(result.scores['codex-contract'] - result.scores['codex-raw']).toBe(2);
    expect(result.pairs.codex.winner).toBe('contract');
    expect(result.pairs.codex.judgeAgreement).toBe(false);
    expect(result.pairs.codex.outcome).toBe('judges disagree');
    expect(result.pairs.codex.decisive).toBe(false);
    expect(summary.paired.codex.decisiveContractWins).toBe(0);
    expect(result.judgeAgreement).toBe(false);
    expect(result.outcome).toBe('judges disagree');
    expect(result.decisive).toBe(false);
  });

  it('accepts review-approved governed output without a merge or operator approval', () => {
    const reviewApproved = {
      condition: 'governed' as const,
      expectedBase: 'abc123',
      changedFiles: ['src/example.ts'],
      commandsPassed: true,
      mechanicalPassed: null,
      durableReviewApproved: true,
      reviewAttempts: 1,
      maxReviewAttempts: 3,
      diffBase: 'abc123',
      diffTruncated: false,
      pipelineFailureReason: null,
    };
    expect(endToEndMeasurementNotes(reviewApproved)).toEqual([]);
  });

  it('records governed review and mechanical defects as measurement notes', () => {
    const withoutApproval = {
      condition: 'governed' as const,
      expectedBase: 'abc123',
      changedFiles: ['src/example.ts'],
      commandsPassed: true,
      mechanicalPassed: null,
      durableReviewApproved: false,
      reviewAttempts: 1,
      maxReviewAttempts: 3,
      diffBase: 'abc123',
      diffTruncated: false,
      pipelineFailureReason: null,
    };
    expect(endToEndMeasurementNotes(withoutApproval)).toContain(
      'governed arm has no durable approved review for current HEAD',
    );
    expect(endToEndMeasurementNotes({
      ...withoutApproval,
      reviewAttempts: 3,
    })).toContain('governed pipeline did not produce an approved review within 3 attempts');
    expect(endToEndMeasurementNotes({
      ...withoutApproval,
      condition: 'adhoc-codex',
      mechanicalPassed: false,
      durableReviewApproved: null,
      diffBase: null,
    })).toContain('mechanical checks failed');
  });

  it('strips governed provenance and fails loudly when a blinded diff still leaks it', () => {
    const worktree = '/tmp/.cortex-worktrees/packet-pkt-1234abcd';
    const lane = 'lane-deadbeef-cafe';
    const packet = 'pkt-1234abcd';
    const mission = 'mission-feedface';
    const agent = 'codex-owned:bench-agent-1676';
    const branch = 'inline/1676-ws-server-crashes';
    const raw = [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      `+export const value = ${JSON.stringify(`${worktree} ${lane} ${packet} ${mission} ${agent} ${branch}`)};`,
      'diff --git a/implementation-notes.md b/implementation-notes.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/implementation-notes.md',
      '@@ -0,0 +1 @@',
      '+review artifact',
      'diff --git a/task-contract.json b/task-contract.json',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/task-contract.json',
      '@@ -0,0 +1 @@',
      '+{}',
      '',
    ].join('\n');
    const markers = [worktree, lane, packet, mission, agent, branch];

    expect(() => assertEndToEndDiffIsBlind(raw, markers)).toThrow('end-to-end blinding leak');
    const blinded = blindEndToEndDiff(raw, markers);
    expect(() => assertEndToEndDiffIsBlind(blinded, markers)).not.toThrow();
    expect(blinded).toContain('diff --git a/src/example.ts b/src/example.ts');
    expect(blinded).not.toContain('implementation-notes.md');
    expect(blinded).not.toContain('task-contract.json');
    expect(blinded).not.toContain(worktree);
    expect(blinded).not.toContain(lane);
    expect(blinded).not.toContain(packet);
    expect(blinded).not.toContain(mission);
    expect(blinded).not.toContain(agent);
    expect(blinded).not.toContain(branch);
  });

  it('requires judge agreement for a decisive shipped-diff winner', () => {
    const endToEndMapping: Record<string, EndToEndCondition> = {
      A: 'adhoc-codex',
      B: 'adhoc-claude',
      C: 'governed',
    };
    const totals: Record<EndToEndCondition, Record<CodingJudge, number>> = {
      'adhoc-codex': { codex: 7, claude: 6 },
      'adhoc-claude': { codex: 10, claude: 2 },
      governed: { codex: 8, claude: 8 },
    };
    const verdicts = Object.entries(endToEndMapping).flatMap(([blindLabel, condition]) => (
      CODING_JUDGES.map((judge): CodingVerdict => ({
        task: task.issue,
        blindLabel,
        judge,
        subScores: {
          correctness: totals[condition][judge],
          scopeDiscipline: totals[condition][judge],
          robustness: totals[condition][judge],
          fit: totals[condition][judge],
        },
        total: totals[condition][judge],
        mostSeriousDefect: '',
      }))
    ));
    const shippedDiffs = {
      [task.issue]: {
        'adhoc-codex': '/tmp/adhoc-codex.diff',
        'adhoc-claude': '/tmp/adhoc-claude.diff',
        governed: '/tmp/governed.diff',
      },
    };

    const summary = scoreEndToEndResults(
      [task],
      verdicts,
      { [task.issue]: endToEndMapping },
      shippedDiffs,
    );
    const result = summary.results[0];

    expect(result.winner).toBe('governed');
    expect(result.margin).toBe(1.5);
    expect(result.judgeAgreement).toBe(false);
    expect(result.outcome).toBe('judges disagree');
    expect(result.decisive).toBe(false);
    expect(summary.decisiveGovernedWins).toBe(0);
  });
});
