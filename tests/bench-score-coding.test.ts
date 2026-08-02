import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

interface CodingTrack {
  status: string;
  lastRun?: { productBarCleared?: boolean };
  metrics?: {
    decisive_contract_wins: { value: number; numerator: number; denominator: number };
    contract_excellent_outputs: { value: number; numerator: number; denominator: number };
  };
}

function runScore(coding: unknown): CodingTrack {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-bench-score-coding-'));
  try {
    mkdirSync(path.join(tmpRoot, 'scripts', 'bench'), { recursive: true });
    mkdirSync(path.join(tmpRoot, 'tests', 'bench', 'latest'), { recursive: true });
    copyFileSync(
      path.join(process.cwd(), 'scripts', 'bench', 'score.mjs'),
      path.join(tmpRoot, 'scripts', 'bench', 'score.mjs'),
    );
    writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    writeFileSync(
      path.join(tmpRoot, 'tests', 'bench', 'latest', 'coding.json'),
      JSON.stringify(coding),
    );

    const result = spawnSync(process.execPath, ['scripts/bench/score.mjs'], {
      cwd: tmpRoot,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const scorecard = JSON.parse(readFileSync(
      path.join(tmpRoot, 'tests', 'bench', 'scorecards', 'scorecard-1.0.0-unknown.json'),
      'utf8',
    )) as { tracks: { coding: CodingTrack } };
    return scorecard.tracks.coding;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

describe('coding scorecard counts', () => {
  it('preserves paired and excellent-output denominators', () => {
    const track = runScore({
      schema: 'o8/coding-benchmark/v2',
      generatedAt: '2026-08-02T00:00:00.000Z',
      tasksScored: 3,
      contractImprovesQuality: true,
      paired: {
        codex: { tasks: 3, decisiveContractWins: 2 },
        claude: { tasks: 3, decisiveContractWins: 3 },
      },
      excellentOutputs: {
        'codex-raw': 1,
        'codex-contract': 2,
        'claude-raw': 0,
        'claude-contract': 1,
      },
    });

    expect(track.status).toBe('ok');
    expect(track.lastRun?.productBarCleared).toBe(true);
    expect(track.metrics?.decisive_contract_wins).toMatchObject({ value: 5, numerator: 5, denominator: 6 });
    expect(track.metrics?.contract_excellent_outputs).toMatchObject({ value: 3, numerator: 3, denominator: 6 });
  });
});
