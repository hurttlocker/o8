import { describe, expect, it } from 'vitest';

import {
  CODING_CONDITIONS,
  CODING_JUDGES,
  type CodingCondition,
  type CodingJudge,
  type CodingTask,
  type CodingVerdict,
  blindCodingDiffs,
  runtimeForCondition,
  scoreCodingResults,
  scrubAuthorship,
  treatmentForCondition,
} from '../scripts/bench/coding';

const tasks: CodingTask[] = [
  { issue: 1, base: 'base', label: 'one' },
  { issue: 2, base: 'base', label: 'two' },
  { issue: 3, base: 'base', label: 'three' },
];

const mapping = Object.fromEntries(CODING_CONDITIONS.map((condition, index) => (
  [String.fromCharCode(65 + index), condition]
))) as Record<string, CodingCondition>;

function verdict(
  task: number,
  condition: CodingCondition,
  judge: CodingJudge,
  total: number,
): CodingVerdict {
  const blindLabel = Object.entries(mapping).find(([, value]) => value === condition)?.[0] ?? '';
  return {
    task,
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

function completeVerdicts(): CodingVerdict[] {
  return tasks.flatMap((task) => CODING_CONDITIONS.flatMap((condition) => (
    CODING_JUDGES.map((judge) => verdict(
      task.issue,
      condition,
      judge,
      treatmentForCondition(condition) === 'contract' ? 9 : 7,
    ))
  )));
}

describe('paired coding benchmark', () => {
  it('contains one raw and one contract-first arm for each initial runtime', () => {
    expect(CODING_CONDITIONS).toEqual([
      'codex-raw',
      'codex-contract',
      'claude-raw',
      'claude-contract',
    ]);
    expect(runtimeForCondition('claude-contract')).toBe('claude');
    expect(treatmentForCondition('codex-contract')).toBe('contract');
  });

  it('blinds condition names and keeps the mapping outside judge inputs', () => {
    const blinded = blindCodingDiffs(1, {
      'codex-raw': '/tmp/raw.diff',
      'claude-contract': '/tmp/contract.diff',
    }, (items) => [...items].reverse());

    expect(blinded.inputs).toEqual([
      { task: 1, blindLabel: 'A', diffPath: '/tmp/contract.diff' },
      { task: 1, blindLabel: 'B', diffPath: '/tmp/raw.diff' },
    ]);
    expect(JSON.stringify(blinded.inputs)).not.toContain('claude');
    expect(blinded.mapping).toEqual({ A: 'claude-contract', B: 'codex-raw' });
  });

  it('requires complete dual-judge task sets and applies the paired product bar', () => {
    const mappings = Object.fromEntries(tasks.map((task) => [task.issue, mapping]));
    const summary = scoreCodingResults(tasks, completeVerdicts(), mappings);

    expect(summary.tasksScored).toBe(3);
    expect(summary.paired.codex.decisiveContractWins).toBe(3);
    expect(summary.paired.claude.decisiveContractWins).toBe(3);
    expect(summary.contractImprovesQuality).toBe(true);
    expect(summary.excellentOutputs['codex-contract']).toBe(3);

    const missingOneJudge = completeVerdicts().filter((entry) => !(
      entry.task === 2 && entry.blindLabel === 'A' && entry.judge === 'claude'
    ));
    const incomplete = scoreCodingResults(tasks, missingOneJudge, mappings);
    expect(incomplete.tasksScored).toBe(2);
    expect(incomplete.contractImprovesQuality).toBe(false);
  });

  it('scrubs provenance paths without changing candidate source text', () => {
    const scrubbed = scrubAuthorship(
      'path /tmp/o8-bench-coding/t1-codex-contract codex claude ginsu implementation-notes.md',
    );
    expect(scrubbed).toBe('path <WORKTREE> codex claude ginsu implementation-notes.md');
  });
});
