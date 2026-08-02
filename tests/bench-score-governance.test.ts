import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

interface GovernanceTrack {
  status: string;
  metrics?: {
    catch_rate: { value: number; numerator: number; denominator: number };
    false_positive_rate: { value: number; numerator: number; denominator: number };
  };
}

function runScore(governance: unknown): GovernanceTrack {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-bench-score-'));
  try {
    mkdirSync(path.join(tmpRoot, 'scripts', 'bench'), { recursive: true });
    mkdirSync(path.join(tmpRoot, 'tests', 'bench', 'latest'), { recursive: true });
    copyFileSync(
      path.join(process.cwd(), 'scripts', 'bench', 'score.mjs'),
      path.join(tmpRoot, 'scripts', 'bench', 'score.mjs'),
    );
    writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    writeFileSync(
      path.join(tmpRoot, 'tests', 'bench', 'latest', 'governance.json'),
      JSON.stringify(governance),
    );

    const result = spawnSync(process.execPath, ['scripts/bench/score.mjs'], {
      cwd: tmpRoot,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const scorecard = JSON.parse(readFileSync(
      path.join(tmpRoot, 'tests', 'bench', 'scorecards', 'scorecard-1.0.0-unknown.json'),
      'utf8',
    )) as { tracks: { governance: GovernanceTrack } };
    return scorecard.tracks.governance;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

describe('governance scorecard counts', () => {
  it('derives both rates from their numerator and denominator', () => {
    const track = runScore({
      summary: {
        catch: { caught: 1, total: 4, rate: 1 },
        falsePositive: { flagged: 2, total: 5, rate: 0 },
        inconclusive: 0,
      },
    });

    expect(track.metrics?.catch_rate).toMatchObject({ value: 0.25, numerator: 1, denominator: 4 });
    expect(track.metrics?.false_positive_rate).toMatchObject({ value: 0.4, numerator: 2, denominator: 5 });
  });

  it('rejects legacy rate-only governance results', () => {
    const track = runScore({ catchRate: 1, fpRate: 0 });

    expect(track.status).toContain('invalid governance result');
    expect(track.metrics).toBeUndefined();
  });
});
