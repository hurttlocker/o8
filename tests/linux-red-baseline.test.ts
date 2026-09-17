import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyAgainstBaseline, loadRedBaseline } from '../scripts/lib/red-baseline.mjs';

const baseline = new Set(['tests/known-red-real-path.test.ts', 'tests/fixed-real-path.test.ts']);

describe('integration gate red baseline', () => {
  it('reports a red baseline file as baseline red, not new red', () => {
    const outcome = classifyAgainstBaseline([{ file: 'tests/known-red-real-path.test.ts', failed: true }], baseline);
    expect(outcome.baselineRed).toEqual(['tests/known-red-real-path.test.ts']);
    expect(outcome.newRed).toEqual([]);
  });

  it('reports a red file outside the baseline as new red', () => {
    const outcome = classifyAgainstBaseline([
      { file: 'tests/known-red-real-path.test.ts', failed: true },
      { file: 'tests/new-break-real-path.test.ts', failed: true },
    ], baseline);
    expect(outcome.newRed).toEqual(['tests/new-break-real-path.test.ts']);
  });

  it('reports a baseline file that now passes', () => {
    const outcome = classifyAgainstBaseline([
      { file: 'tests/fixed-real-path.test.ts', failed: false },
      { file: 'tests/always-green-real-path.test.ts', failed: false },
    ], baseline);
    expect(outcome.nowGreen).toEqual(['tests/fixed-real-path.test.ts']);
    expect(outcome.green).toHaveLength(2);
    expect(outcome.ran).toBe(2);
  });

  it('stays strict when the baseline file is missing', () => {
    const missing = loadRedBaseline(join(__dirname, 'no-such-baseline.json'));
    expect(missing).toBeNull();
    const outcome = classifyAgainstBaseline([{ file: 'tests/known-red-real-path.test.ts', failed: true }], missing);
    expect(outcome.newRed).toEqual(['tests/known-red-real-path.test.ts']);
    expect(loadRedBaseline(undefined)).toBeNull();
  });

  it('loads the recorded Linux baseline, which lists only resource-owning files', async () => {
    const recorded = loadRedBaseline(join(__dirname, 'integration-linux-baseline.json'));
    expect(recorded?.size).toBe(45);
    const { default: classification } = await import('./test-classification.json');
    const owning = new Set(classification.resourceOwning.map((entry: { path: string }) => entry.path));
    expect([...(recorded ?? [])].filter((path) => !owning.has(path))).toEqual([]);
  });
});
