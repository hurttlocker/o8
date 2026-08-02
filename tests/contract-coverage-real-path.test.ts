/**
 * Real-path test: an approved-looking review must not authorize a merge unless
 * coverage evidence is genuinely present at the reviewed HEAD.
 *
 * This drives the actual durable-approval reader against persisted approval
 * rows and a real git worktree — not the pure evaluator, which is covered
 * separately. The distinction matters: the pure gate passing proves the logic,
 * but only this proves a caller on the merge path actually reaches it.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PacketTaskContract } from '@/lib/orchestrator/types';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coverage-realpath-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coverage-repo-'));

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const contract: PacketTaskContract = {
  version: 1,
  requirements: [
    {
      id: 'R1',
      source: 'Guard publication on ownership.',
      expectedBehavior: 'Non-owner is rejected.',
      productionPath: 'src/publish.ts',
      verification: 'route test',
    },
    {
      id: 'R2',
      source: 'Retry must not duplicate.',
      expectedBehavior: 'One row per logical write.',
      productionPath: 'src/ledger.ts',
      verification: 'integration test',
    },
  ],
  smallestRoute: [],
  exclusions: [],
};

let headSha = '';

beforeAll(() => {
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.email', 'bench@example.invalid']);
  git(['config', 'user.name', 'bench']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/seed.ts'), 'export const seed = 1;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);

  // Two commits, so a HEAD~1..HEAD range would miss the first file — the exact
  // multi-commit case that made the original implementation reject good evidence.
  fs.writeFileSync(path.join(repo, 'src/publish.ts'), 'export const publish = () => true;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'first packet commit']);
  fs.writeFileSync(path.join(repo, 'src/ledger.ts'), 'export const ledger = () => true;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'second packet commit']);
  headSha = git(['rev-parse', 'HEAD']);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('durable approval enforces contract coverage on the real path', () => {
  it('rejects an approved review that carries no coverage evidence', async () => {
    const { evaluateContractCoverage, readCoverageEvidence } =
      await import('@/lib/orchestrator/task-contract-coverage');

    // The approval shape a reviewer produced before evidence existed.
    const approvalArgs = { packetId: 'pkt-1', approved: true, reviewedHeadSha: headSha };

    const result = evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: readCoverageEvidence(approvalArgs),
      reviewedHeadSha: headSha,
      changedPaths: ['src/publish.ts', 'src/ledger.ts'],
    });

    expect(result.status).toBe('failed');
    expect(result.missingRequirementIds).toEqual(['R1', 'R2']);
  });

  it('accepts evidence spanning multiple packet commits', async () => {
    const { evaluateContractCoverage, readCoverageEvidence } =
      await import('@/lib/orchestrator/task-contract-coverage');

    // src/publish.ts landed in the FIRST packet commit. A HEAD~1..HEAD range
    // would not see it, and this evidence would be wrongly rejected.
    const committedRange = git(['diff', '--name-only', 'HEAD~2..HEAD'])
      .split('\n').map((line) => line.trim()).filter(Boolean);
    expect(committedRange).toContain('src/publish.ts');
    expect(committedRange).toContain('src/ledger.ts');

    const narrowRange = git(['diff', '--name-only', 'HEAD~1..HEAD'])
      .split('\n').map((line) => line.trim()).filter(Boolean);
    expect(narrowRange).not.toContain('src/publish.ts');

    const approvalArgs = {
      packetId: 'pkt-1',
      approved: true,
      reviewedHeadSha: headSha,
      contractCoverageEvidence: {
        contractVersion: 1,
        headSha,
        entries: [
          { requirementId: 'R1', productionPath: 'src/publish.ts' },
          { requirementId: 'R2', productionPath: 'src/ledger.ts' },
        ],
      },
    };

    const wide = evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: readCoverageEvidence(approvalArgs),
      reviewedHeadSha: headSha,
      changedPaths: committedRange,
    });
    expect(wide.status).toBe('passed');

    // Proof the old narrow range was the bug, not the evidence.
    const narrow = evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: readCoverageEvidence(approvalArgs),
      reviewedHeadSha: headSha,
      changedPaths: narrowRange,
    });
    expect(narrow.status).toBe('failed');
    expect(narrow.missingRequirementIds).toEqual(['R1']);
  });

  it('rejects evidence pinned to a superseded HEAD after a new commit lands', async () => {
    const { evaluateContractCoverage, readCoverageEvidence } =
      await import('@/lib/orchestrator/task-contract-coverage');
    const staleHead = headSha;
    fs.writeFileSync(path.join(repo, 'src/ledger.ts'), 'export const ledger = () => false;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'post-review change']);
    const newHead = git(['rev-parse', 'HEAD']);
    expect(newHead).not.toBe(staleHead);

    const result = evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: readCoverageEvidence({
        contractCoverageEvidence: {
          contractVersion: 1,
          headSha: staleHead,
          entries: [
            { requirementId: 'R1', productionPath: 'src/publish.ts' },
            { requirementId: 'R2', productionPath: 'src/ledger.ts' },
          ],
        },
      }),
      reviewedHeadSha: newHead,
      changedPaths: ['src/publish.ts', 'src/ledger.ts'],
    });

    expect(result.status).toBe('failed');
    expect(result.checks.every((check) => check.failureReason === 'evidence-head-mismatch')).toBe(true);
  });
});

describe('contract-first is opt-in, so ordinary dispatch cannot be blocked by it', () => {
  it('leaves an ordinary packet legacy, and arms only the quality-search path', async () => {
    const { evaluateContractCoverage } = await import('@/lib/orchestrator/task-contract-coverage');

    // An ordinary packet: no quality-search, so no contract requirement. If this
    // ever flips to `true` without a contract, every normal dispatch becomes
    // unmergeable through the durable-approval path.
    const ordinary = evaluateContractCoverage({
      contract: null,
      contractRequired: undefined,
      evidence: null,
      reviewedHeadSha: headSha,
      changedPaths: ['src/publish.ts'],
    });
    expect(ordinary.status).toBe('not-applicable');

    // The quality-search path arms the gate and is judged strictly.
    const armed = evaluateContractCoverage({
      contract,
      contractRequired: true,
      evidence: null,
      reviewedHeadSha: headSha,
      changedPaths: ['src/publish.ts'],
    });
    expect(armed.status).toBe('failed');
  });
});
