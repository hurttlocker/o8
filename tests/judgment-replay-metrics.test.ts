import { describe, expect, it } from 'vitest';

import { auc, brier, leaveOnePacketOutCatchAll, reliabilityTable, type ScoredRow } from '../scripts/lib/judgment-replay-metrics.mjs';

const rows: ScoredRow[] = [
  { p: 0.9, y: 1, packet: 'a' },
  { p: 0.6, y: 1, packet: 'b' },
  { p: 0.6, y: 0, packet: 'c' },
  { p: 0.7, y: 0, packet: 'c' },
  { p: 0.1, y: 0, packet: 'd' },
];

describe('judgment replay metrics', () => {
  it('computes rank AUC with ties counted half, and null without both classes', () => {
    // pairs: 0.9 beats 3; 0.6 ties 0.6 (0.5), loses to 0.7, beats 0.1 -> 4.5 of 6
    expect(auc(rows)).toBeCloseTo(4.5 / 6, 10);
    expect(auc(rows.filter((row) => row.y === 0))).toBeNull();
  });

  it('computes Brier as mean squared error', () => {
    expect(brier([{ p: 0.75, y: 1, packet: 'a' }, { p: 0.25, y: 0, packet: 'b' }])).toBeCloseTo(0.0625, 10);
    expect(brier([])).toBeNull();
  });

  it('bins into ten equal-width bins with 1.0 in the last bin', () => {
    const table = reliabilityTable([...rows, { p: 1, y: 1, packet: 'e' }]);
    expect(table).toHaveLength(10);
    expect(table[9]).toMatchObject({ n: 2, observedRate: 1 });
    expect(table[6]).toMatchObject({ n: 2, observedRate: 0.5 });
    expect(table[6].meanPredicted).toBeCloseTo(0.6, 10);
    expect(table[3]).toMatchObject({ n: 0, meanPredicted: null, observedRate: null });
  });

  it('fits the catch-every-positive threshold without the held-out packet', () => {
    const result = leaveOnePacketOutCatchAll(rows);
    // fold a: threshold 0.6 (from b) -> a caught. fold b: threshold 0.9 (from a) -> b missed.
    // folds c, d: threshold 0.6 -> 0.6 and 0.7 alarm, 0.1 does not.
    expect(result).toMatchObject({
      folds: 4,
      scoredFolds: 4,
      misses: 1,
      positivesEvaluated: 2,
      falseAlarms: 2,
      negativesEvaluated: 3,
      rowsWithoutTrainingPositive: 0,
    });
  });

  it('counts held-out rows that have no positive elsewhere instead of fitting in-sample', () => {
    const result = leaveOnePacketOutCatchAll([
      { p: 0.9, y: 1, packet: 'only' },
      { p: 0.2, y: 0, packet: 'only' },
      { p: 0.3, y: 0, packet: 'other' },
    ]);
    expect(result).toMatchObject({ folds: 2, scoredFolds: 1, rowsWithoutTrainingPositive: 2, falseAlarms: 0, negativesEvaluated: 1 });
  });
});
