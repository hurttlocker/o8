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

import type { OrchestratorPacket, PacketTaskContract, PacketTaskContractSource } from '@/lib/orchestrator/types';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coverage-realpath-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coverage-repo-'));
const reviewRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coverage-review-repo-'));

const { recordOrchestratorReview } = await import('@/lib/approvals/store');
const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } =
  await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

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
let reviewHeadSha = '';

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

  git(['init', '-q', '--initial-branch=main'], reviewRepo);
  git(['config', 'user.email', 'review@example.invalid'], reviewRepo);
  git(['config', 'user.name', 'review'], reviewRepo);
  fs.writeFileSync(path.join(reviewRepo, 'file.txt'), 'base\n');
  git(['add', '-A'], reviewRepo);
  git(['commit', '-q', '-m', 'base'], reviewRepo);
  git(['checkout', '-q', '-b', 'inline/contract-review'], reviewRepo);
  fs.writeFileSync(path.join(reviewRepo, 'file.txt'), 'base\npacket change\n');
  git(['add', '-A'], reviewRepo);
  git(['commit', '-q', '-m', 'packet change'], reviewRepo);
  reviewHeadSha = git(['rev-parse', 'HEAD'], reviewRepo);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(reviewRepo, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const capturedContract: PacketTaskContract = {
  version: 1,
  requirements: [{
    id: 'R1',
    source: 'Enforce a captured default contract.',
    expectedBehavior: 'The durable approval path requires coverage evidence.',
    productionPath: 'file.txt',
    verification: 'real durable approval test',
  }],
  smallestRoute: [{
    path: 'file.txt',
    requirements: ['R1'],
    reason: 'The packet changes one file.',
  }],
  exclusions: [],
};

async function assessPersistedContractPacket(input: {
  source: PacketTaskContractSource;
  taskContract?: PacketTaskContract;
}) {
  const packetId = `pkt-contract-review-${input.source}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const lane = createLane({
    repoPath: reviewRepo,
    worktreePath: reviewRepo,
    branch: 'inline/contract-review',
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
  });
  const packet: OrchestratorPacket = {
    id: packetId,
    referenceLabel: 'P1',
    title: 'Contract review',
    summary: 'Contract review',
    workspaceTargetPath: reviewRepo,
    branchTarget: 'inline/contract-review',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'awaiting_review',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: null,
    taskContractRequired: true,
    taskContractSource: input.source,
    taskContract: input.taskContract ?? null,
  };
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${packetId}`,
    prompt: 'Contract review',
    summary: 'Contract review',
    repoPath: reviewRepo,
    packets: [packet],
  });
  expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
    id: packetId,
    taskContractRequired: true,
    taskContractSource: input.source,
  });
  recordOrchestratorReview(packetId, {
    approved: true,
    findings: [],
    reviewer: 'codex',
    reviewedHeadSha: reviewHeadSha,
    requiresSecondPass: false,
  });

  return {
    lane,
    assessment: await assessDurableApprovedReview(lane),
  };
}

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

describe('legacy packets remain outside the contract gate', () => {
  it('leaves an unstamped packet legacy while enforcing an explicitly armed packet', async () => {
    const { evaluateContractCoverage } = await import('@/lib/orchestrator/task-contract-coverage');

    const legacy = evaluateContractCoverage({
      contract: null,
      contractRequired: undefined,
      evidence: null,
      reviewedHeadSha: headSha,
      changedPaths: ['src/publish.ts'],
    });
    expect(legacy.status).toBe('not-applicable');

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

describe('default-armed contract capture fails soft on the durable approval path', () => {
  it('lets a default-armed packet without a captured contract proceed and records the missing event', async () => {
    const { lane, assessment } = await assessPersistedContractPacket({ source: 'default' });

    expect(assessment).toMatchObject({ approved: true, contractCoverage: null });
    const missingEvents = getLaneEvents(lane.id)
      .filter((event) => event.verb === 'task_contract_missing');
    expect(missingEvents).toHaveLength(1);
    expect(missingEvents[0]?.payload).toMatchObject({
      runtime: 'codex',
      reason: expect.any(String),
    });
  });

  it('enforces coverage for a default-armed packet when the contract was captured', async () => {
    const { lane, assessment } = await assessPersistedContractPacket({
      source: 'default',
      taskContract: capturedContract,
    });

    expect(assessment).toMatchObject({
      approved: false,
      contractCoverage: { status: 'failed', missingRequirementIds: ['R1'] },
    });
    expect(getLaneEvents(lane.id).some((event) => event.verb === 'task_contract_missing')).toBe(false);
  });

  it('keeps an explicitly armed packet without a captured contract blocked', async () => {
    const { lane, assessment } = await assessPersistedContractPacket({ source: 'explicit' });

    expect(assessment).toMatchObject({
      approved: false,
      contractCoverage: { status: 'failed' },
    });
    expect(getLaneEvents(lane.id).some((event) => event.verb === 'task_contract_missing')).toBe(false);
  });
});
