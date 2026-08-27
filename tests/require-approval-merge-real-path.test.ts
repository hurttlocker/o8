import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const { publishRealtimeMutation } = vi.hoisted(() => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation }));

process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const tempDirs: string[] = [];
const defaultsPath = join(process.env.CORTEX_IDE_DATA_DIR!, 'operator-defaults.json');
const settingsTomlPath = join(process.env.CORTEX_IDE_DATA_DIR!, 'settings.toml');

const {
  expireStaleApprovals,
  getApproval,
  listApprovals,
  listApprovalsForContext,
  recordOrchestratorReview,
} = await import('@/lib/approvals/store');
const { claimApprovalResolution } = await import('@/lib/approvals/resolution');
const { getSqlite } = await import('@/lib/db');
const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const approvalsRoute = await import('@/app/api/panel/approvals/route');
const reviewRoute = await import('@/app/api/orchestrator/review/route');
const reviewStateRoute = await import('@/app/api/orchestrator/review-state/route');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { recordMission } = await import('@/lib/db/missions-store');
const { dispatch } = await import('@/lib/lane/commands');
const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { decideSurfaceMerge } = await import('@/lib/lane/surface-merge-decision');
const { archiveLane, createLane, getLane } = await import('@/lib/lane/registry');
const { withRepoActionLock } = await import('@/lib/lane/repo-action-lock');
const { handleWaitForMissionReady } = await import('@/lib/mcp/operator-handlers/mission');
const { getOperatorDefaults, updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { addRepo } = await import('@/lib/repos/registry');
const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');
const {
  readOrchestratorControlPlaneState,
  withControlPlaneLock,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { scanRepo } = await import('@/lib/skeleton');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { createWorkspaceSnapshot, transitionWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
}

async function createStandardLane(label: string, recordReview = true, highRisk = false, gateBlocked = false) {
  const root = mkdtempSync(join(os.tmpdir(), `o8-require-approval-${label}-`));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  const packetId = `pkt-require-approval-${label}-${Date.now()}`;
  const branch = `inline/require-approval-${label}-${Date.now()}`;
  tempDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);

  const manager = getWorktreeManager(repo);
  const worktree = await manager.create({
    agentType: 'codex',
    taskName: packetId,
    branchName: branch,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
  git(worktree.path, ['config', 'user.name', 'o8-test']);
  git(worktree.path, ['config', 'user.email', 'o8@example.test']);
  const changedPath = highRisk || gateBlocked
    ? join(worktree.path, 'src/lib/lane/commands.ts')
    : join(worktree.path, 'file.txt');
  if (highRisk || gateBlocked) {
    mkdirSync(join(worktree.path, 'src/lib/lane'), { recursive: true });
  }
  writeFileSync(
    changedPath,
    gateBlocked
      ? "export const unsafeControlPlaneChange = eval('2 + 2');\n"
      : highRisk
        ? 'export const controlPlaneChange = true;\n'
        : 'base\nstandard change\n',
  );
  commitAll(worktree.path, 'standard change');

  const reviewedHeadSha = git(worktree.path, ['rev-parse', 'HEAD']);
  const lane = createLane({
    repoPath: repo,
    worktreePath: worktree.path,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
    label: `Standard diff ${label}`,
  });
  if (recordReview) {
    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [],
      reviewer: 'codex',
      reviewedHeadSha,
      requiresSecondPass: false,
    });
  }

  return {
    lane,
    repo,
    reviewedHeadSha,
    baseHeadSha: git(repo, ['rev-parse', 'HEAD']),
  };
}

async function createBudgetBlockedLane(label: string) {
  const root = mkdtempSync(join(os.tmpdir(), `o8-require-approval-${label}-`));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  const packetId = `pkt-require-approval-${label}-${Date.now()}`;
  const branch = `inline/require-approval-${label}-${Date.now()}`;
  tempDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'safe.ts'), [
    ...Array.from({ length: 10 }, (_, index) => `export const base${index} = ${index};`),
    '',
  ].join('\n'));
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);
  await scanRepo({ repoPath: repo, chunks: false });

  const worktree = await getWorktreeManager(repo).create({
    agentType: 'codex',
    taskName: packetId,
    branchName: branch,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
  git(worktree.path, ['config', 'user.name', 'o8-test']);
  git(worktree.path, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(worktree.path, 'safe.ts'), [
    ...Array.from({ length: 10 }, (_, index) => `export const base${index} = ${index};`),
    ...Array.from({ length: 10 }, (_, index) => `export const expansion${index} = ${index};`),
    '',
  ].join('\n'));
  commitAll(worktree.path, 'expand safe module');
  const reviewedHeadSha = git(worktree.path, ['rev-parse', 'HEAD']);
  const lane = createLane({
    repoPath: repo,
    worktreePath: worktree.path,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
    label: `Budget diff ${label}`,
  });
  return { lane, repo, reviewedHeadSha };
}

function persistDispatcherMission(
  packetId: string,
  repoPath: string,
  orchestratorThreadId: string,
  packetOverrides: Partial<OrchestratorPacket> = {},
) {
  const missionId = `mission-surface-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const missionState = normalizeOrchestratorMissionState({
    version: 2,
    missionId,
    prompt: 'Surface approval routing',
    summary: 'Surface approval routing',
    repoPath,
    runtime: 'codex',
    constraints: '',
    packets: [{
      id: packetId,
      referenceLabel: 'surface-review',
      title: 'Surface review',
      summary: 'Surface review',
      workspaceTargetPath: repoPath,
      branchTarget: 'inline/surface-review',
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'released',
      releaseState: 'pending',
      status: 'running',
      blockedReason: null,
      lastEventAt: null,
      lastEventLabel: null,
      archivedAt: null,
      review: null,
      lane: null,
      orchestratorThreadId,
      dispatcher: { surface: 'orchestrator', id: orchestratorThreadId },
      ...packetOverrides,
    }],
    updatedAt: new Date().toISOString(),
  });
  recordMission({
    id: missionId,
    repoPath,
    runtime: 'codex',
    prompt: missionState.prompt,
    summary: missionState.summary,
    constraints: '',
    packetMeta: missionState.packets.map((packet) => ({
      id: packet.id,
      title: packet.title,
      referenceLabel: packet.referenceLabel,
    })),
    missionState,
    totalWaves: 1,
  });
  writeOrchestratorControlPlaneState(missionState);
  return missionId;
}

function mergeRequest(token: string, packetId: string): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/merge', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ packetId, idempotencyKey: randomUUID() }),
  });
}

function reviewRequest(
  token: string,
  packetId: string,
  reviewedHeadSha: string,
  contractCoverageEvidence?: {
    contractVersion: number;
    headSha: string;
    entries: Array<{
      requirementId: string;
      productionPath: string;
      anchor?: string;
      verification?: string;
    }>;
  },
): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/review', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      packetId,
      clientMutationId: randomUUID(),
      approved: true,
      reviewedHeadSha,
      contractCoverageEvidence,
      findings: [{
        file: 'safe.ts',
        severity: 'note',
        description: 'The expansion is intentional and reviewed.',
        status: 'accepted',
      }],
    }),
  });
}

beforeEach(() => {
  rmSync(defaultsPath, { force: true });
  rmSync(settingsTomlPath, { force: true });
  publishRealtimeMutation.mockClear();
});

afterEach(() => {
  rmSync(defaultsPath, { force: true });
  rmSync(settingsTomlPath, { force: true });
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('requireApproval merge governance through the real command path', () => {
  it('refuses the real merge route when a parked path is occupied by an unrelated checkout at the reviewed HEAD', async () => {
    const fixture = await createStandardLane('parked-occupant-route');
    const replacementPath = `${fixture.lane.worktreePath}-replacement`;
    execFileSync('git', ['clone', fixture.lane.worktreePath!, replacementPath], { stdio: 'pipe' });
    git(fixture.repo, ['worktree', 'remove', '--force', fixture.lane.worktreePath!]);
    renameSync(replacementPath, fixture.lane.worktreePath!);
    writeFileSync(join(fixture.lane.worktreePath!, 'unrelated-sentinel'), 'must survive\n');
    const repo = await addRepo(fixture.repo);
    let snapshot = createWorkspaceSnapshot({
      repositoryUuid: repo.id,
      packetId: fixture.lane.packetId!,
      laneId: fixture.lane.id,
      originalPath: fixture.lane.worktreePath!,
      branch: fixture.lane.branch,
      baseCommit: fixture.baseHeadSha,
      headCommit: fixture.reviewedHeadSha,
      treeSha: git(fixture.lane.worktreePath!, ['rev-parse', 'HEAD^{tree}']),
      recoveryRef: `refs/o8/recovery/${fixture.lane.packetId}`,
      diffFingerprint: 'parked-route-diff',
      sessionIdentities: [{ kind: 'owned-session', identity: fixture.lane.sessionKey! }],
      creationId: `parked-route-${fixture.lane.packetId}-created`,
    }).record;
    for (const state of ['parkable', 'hibernating', 'parked'] as const) {
      const result = transitionWorkspaceSnapshot({
        repositoryUuid: repo.id,
        packetId: fixture.lane.packetId!,
        transitionId: `parked-route-${state}-${fixture.lane.packetId}`,
        expectedState: snapshot.state,
        expectedVersion: snapshot.version,
        toState: state,
      });
      if (result.status !== 'applied') throw new Error(`Could not transition to ${state}.`);
      snapshot = result.record;
    }
    persistDispatcherMission(
      fixture.lane.packetId!,
      fixture.repo,
      `thoughts-parked-route-${Date.now()}`,
    );

    const response = await mergeRoute.POST(mergeRequest(
      getOrCreateWsToken(),
      fixture.lane.packetId!,
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      result: { merged: false, reason: 'workspace_restore_required' },
    });
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(fixture.baseHeadSha);
    expect(git(fixture.lane.worktreePath!, ['rev-parse', 'HEAD'])).toBe(fixture.reviewedHeadSha);
    expect(readFileSync(join(fixture.lane.worktreePath!, 'unrelated-sentinel'), 'utf8'))
      .toBe('must survive\n');
  }, 30_000);

  it('persists task-contract evidence through the review route and clears the durable coverage gate', async () => {
    const fixture = await createStandardLane('contract-evidence', false);
    const taskContract = {
      version: 1 as const,
      requirements: [{
        id: 'R1',
        source: 'Persist reviewed requirement evidence.',
        expectedBehavior: 'The durable review reads evidence from approval args.',
        productionPath: 'file.txt',
        verification: 'Read the committed file.',
      }],
      smallestRoute: [{
        path: 'file.txt',
        requirements: ['R1'],
        reason: 'The task changes one existing file.',
      }],
      exclusions: [],
    };
    persistDispatcherMission(
      fixture.lane.packetId!,
      fixture.repo,
      `thoughts-contract-${Date.now()}`,
      { taskContract, taskContractRequired: true },
    );

    const response = await reviewRoute.POST(reviewRequest(
      getOrCreateWsToken(),
      fixture.lane.packetId!,
      fixture.reviewedHeadSha,
      {
        contractVersion: 1,
        headSha: fixture.reviewedHeadSha,
        entries: [{
          requirementId: 'R1',
          productionPath: 'file.txt',
          anchor: 'standard change',
          verification: 'Read the committed file.',
        }],
      },
    ));

    expect(response.status).toBe(200);
    const approval = listApprovalsForContext({ laneId: fixture.lane.id })
      .find((candidate) => candidate.toolName === 'orchestrator_review');
    expect(approval?.args?.contractCoverageEvidence).toMatchObject({
      contractVersion: 1,
      headSha: fixture.reviewedHeadSha,
      entries: [{ requirementId: 'R1', productionPath: 'file.txt' }],
    });
    await expect(assessDurableApprovedReview(fixture.lane)).resolves.toMatchObject({
      approved: true,
      contractCoverage: { status: 'passed', missingRequirementIds: [] },
    });
  }, 30_000);

  it('does not let a pending review waive spoken merge-gate blockers', async () => {
    const fixture = await createBudgetBlockedLane('pending-spoken-review');
    recordOrchestratorReview(fixture.lane.packetId!, {
      approved: true,
      findings: [{
        file: 'safe.ts',
        severity: 'note',
        description: 'The expansion still needs operator acceptance.',
        resolution: 'deferred',
      }],
      reviewer: 'codex',
      reviewedHeadSha: fixture.reviewedHeadSha,
      requiresSecondPass: false,
    });
    expect(listApprovalsForContext({ laneId: fixture.lane.id })
      .find((candidate) => candidate.toolName === 'orchestrator_review'))
      .toMatchObject({ status: 'pending', args: { approved: true } });

    const response = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(fixture.lane.packetId!)}&spoken=1`,
      { headers: { host: 'localhost:3001' } },
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.spokenReview.review.verdict).toBe('approved');
    expect(payload.spokenReview.mergeGate.verdict).toBe('failing');
    expect(payload.spokenReview.mergeGate.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ verdict: 'fail' }),
    ]));
  }, 30_000);

  it('keeps approved gate-blocked work operator-actionable and surfaces its preserved ref through status reads', async () => {
    await updateOperatorDefaults({ requireApproval: 'surface' });
    const gated = await createStandardLane('recoverable-gate-block', true, true, true);
    persistDispatcherMission(gated.lane.packetId!, gated.repo, `thoughts-recovery-${Date.now()}`);

    const response = await mergeRoute.POST(mergeRequest(getOrCreateWsToken(), gated.lane.packetId!));
    const payload = await response.json();
    const parked = getLane(gated.lane.id);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, result: { merged: false } });
    expect(parked).toMatchObject({
      status: 'reviewing',
      worktreePath: gated.lane.worktreePath,
    });
    expect(payload.result.note).toContain('Reviewed work preserved at preserved/');

    const status = await getMissionStatus({ includeCost: false });
    const statusPacket = status.packets.find((candidate) => candidate.id === gated.lane.packetId);
    expect(statusPacket).toMatchObject({
      status: 'awaiting_review',
      recovery: {
        outcome: 'archived_recoverable',
        preservedHeadSha: gated.reviewedHeadSha,
        recommendedAction: 'retry_packet',
      },
    });
    expect(statusPacket?.blockedReason).toBeNull();
    const preservedRef = statusPacket!.recovery!.preservedRef;
    expect(git(gated.repo, ['rev-parse', preservedRef])).toBe(gated.reviewedHeadSha);

    const reviewResponse = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(gated.lane.packetId!)}&spoken=1`,
      { headers: { host: 'localhost:3001' } },
    ));
    const reviewPayload = await reviewResponse.json();
    expect(reviewPayload.recovery).toMatchObject({
      preservedRef,
      preservedHeadSha: gated.reviewedHeadSha,
    });
    expect(reviewPayload.spokenReview).toMatchObject({
      packetId: gated.lane.packetId,
      review: { verdict: 'approved' },
      tests: { status: 'not-reported' },
    });
    expect(reviewPayload.spokenReview.files.count).toBeGreaterThanOrEqual(1);
    expect(reviewPayload.spokenReview.files.touched).toContain('src/lib/lane/commands.ts');
    expect(reviewPayload.spokenReview.riskFlags).toContain(
      'path-glob: live lane state machine: src/lib/lane/commands.ts',
    );
    expect(reviewPayload.spokenReview.spokenSummary).not.toContain('@@');

    const untrackedPath = join(gated.lane.worktreePath!, 'unreviewed-note.txt');
    writeFileSync(untrackedPath, 'changed after AI review\n');
    const dirtyReviewResponse = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(gated.lane.packetId!)}&spoken=1`,
      { headers: { host: 'localhost:3001' } },
    ));
    const dirtyReviewPayload = await dirtyReviewResponse.json();
    expect(dirtyReviewPayload.spokenReview).toMatchObject({
      evidence: { headSha: gated.reviewedHeadSha },
      review: { verdict: 'unreviewed' },
    });
    expect(dirtyReviewPayload.spokenReview.files.touched).toContain('unreviewed-note.txt');
    expect(dirtyReviewPayload.spokenReview.riskFlags).toContain('untracked changes: 1 file');
    expect(dirtyReviewPayload.spokenReview.evidence.fingerprint)
      .not.toBe(reviewPayload.spokenReview.evidence.fingerprint);
    rmSync(untrackedPath);

    const archived = archiveLane(gated.lane.id, 'system');
    expect(archived).toMatchObject({
      status: 'archived',
      outcome: 'archived_recoverable',
    });
    expect(archived?.outcomeNote).toContain(`Reviewed work preserved at ${preservedRef}`);
    const archivedStatus = await getMissionStatus({ includeCost: false });
    expect(archivedStatus.packets.find((candidate) => candidate.id === gated.lane.packetId)).toMatchObject({
      status: 'archived',
      recovery: { preservedRef, preservedHeadSha: gated.reviewedHeadSha },
    });
  }, 60_000);

  it('applies an accepted diff-budget finding before the real submit_review auto-merge can read stale mission state', async () => {
    await updateOperatorDefaults({ requireApproval: 'surface' });
    const fixture = await createBudgetBlockedLane('accepted-budget-race');
    persistDispatcherMission(fixture.lane.packetId!, fixture.repo, `thoughts-budget-${Date.now()}`);
    const token = getOrCreateWsToken();

    let releaseControlPlane!: () => void;
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => { lockHeld = resolve; });
    const release = new Promise<void>((resolve) => { releaseControlPlane = resolve; });
    const lock = withControlPlaneLock(async () => {
      lockHeld();
      await release;
    });
    await held;

    const reviewPromise = reviewRoute.POST(reviewRequest(
      token,
      fixture.lane.packetId!,
      fixture.reviewedHeadSha,
    ));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const auditLanded = listApprovalsForContext({ laneId: fixture.lane.id }).some((approval) => (
        approval.toolName === 'orchestrator_review'
        && approval.status === 'approved'
        && Array.isArray(approval.args?.findings)
      ));
      if (auditLanded) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const mergePromise = mergeRoute.POST(mergeRequest(token, fixture.lane.packetId!));
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseControlPlane();
    await lock;
    const [reviewResponse, mergeResponse] = await Promise.all([reviewPromise, mergePromise]);
    const mergePayload = await mergeResponse.json();

    expect(reviewResponse.status).toBe(200);
    expect(mergePayload).toMatchObject({ ok: true, result: { merged: true } });
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(fixture.reviewedHeadSha);
    expect(getLane(fixture.lane.id)?.status).not.toBe('archived');
  }, 60_000);

  it('treats an operator approve_and_merge as the surface approval without weakening worker or merge-gate enforcement', async () => {
    await updateOperatorDefaults({ requireApproval: 'surface' });

    const operator = await createStandardLane('surface-operator-explicit', true, true);
    persistDispatcherMission(operator.lane.packetId!, operator.repo, `thoughts-operator-${Date.now()}`);
    const operatorResponse = await mergeRoute.POST(mergeRequest(getOrCreateWsToken(), operator.lane.packetId!));
    const operatorPayload = await operatorResponse.json();

    expect(operatorResponse.status).toBe(200);
    expect(operatorPayload).toMatchObject({ ok: true, result: { merged: true } });
    expect(git(operator.repo, ['rev-parse', 'HEAD'])).toBe(operator.reviewedHeadSha);
    expect(listApprovalsForContext({ laneId: operator.lane.id }).some((candidate) => (
      candidate.status === 'pending' && candidate.policyRuleId === 'surface-dispatcher-review'
    ))).toBe(false);

    const worker = await createStandardLane('surface-worker-explicit', true, true);
    const workerDispatcherId = `thoughts-worker-${Date.now()}`;
    persistDispatcherMission(worker.lane.packetId!, worker.repo, workerDispatcherId);
    const workerResponse = await mergeRoute.POST(mergeRequest(
      mintPacketWorkerToken(worker.lane.packetId!),
      worker.lane.packetId!,
    ));
    const workerPayload = await workerResponse.json();

    expect(workerResponse.status).toBe(200);
    expect(workerPayload).toMatchObject({
      ok: true,
      result: { merged: false, status: 'pending_operator_approval' },
    });
    expect(git(worker.repo, ['rev-parse', 'HEAD'])).toBe(worker.baseHeadSha);
    const workerApproval = listApprovalsForContext({ laneId: worker.lane.id })
      .find((candidate) => candidate.id === workerPayload.result.approvalId);
    expect(workerApproval).toMatchObject({
      status: 'pending',
      policyRuleId: 'worker-merge-governance',
      args: {
        approvalRoute: 'dispatcher',
        dispatcherId: workerDispatcherId,
      },
    });

    const gated = await createStandardLane('surface-gate-blocked', true, true, true);
    persistDispatcherMission(gated.lane.packetId!, gated.repo, `thoughts-gated-${Date.now()}`);
    const gatedResponse = await mergeRoute.POST(mergeRequest(getOrCreateWsToken(), gated.lane.packetId!));
    const gatedPayload = await gatedResponse.json();

    expect(gatedResponse.status).toBe(200);
    expect(gatedPayload).toMatchObject({ ok: true, result: { merged: false } });
    expect(gatedPayload.result.approvalId).toBeTruthy();
    expect(git(gated.repo, ['rev-parse', 'HEAD'])).toBe(gated.baseHeadSha);
    expect(listApprovalsForContext({ laneId: gated.lane.id })
      .find((candidate) => candidate.id === gatedPayload.result.approvalId))
      .toMatchObject({ status: 'pending', policyRuleId: 'merge-gate-violation' });
  }, 60_000);

  it('removes retry recovery metadata after the real merge route releases a packet', async () => {
    const fixture = await createStandardLane('released-recovery-coherence');
    persistDispatcherMission(fixture.lane.packetId!, fixture.repo, `thoughts-recovery-coherence-${Date.now()}`);
    const beforeMerge = readOrchestratorControlPlaneState();
    beforeMerge.packets[0]!.recovery = {
      outcome: 'archived_recoverable',
      preservedRef: 'preserved/reviewed-work',
      preservedHeadSha: fixture.reviewedHeadSha,
      message: 'Reviewed work remains preserved for retry.',
      recommendedAction: 'retry_packet',
    };
    writeOrchestratorControlPlaneState(beforeMerge);

    const response = await mergeRoute.POST(mergeRequest(getOrCreateWsToken(), fixture.lane.packetId!));
    const payload = await response.json();
    const status = await getMissionStatus({ includeCost: false });
    const packet = status.packets.find((candidate) => candidate.id === fixture.lane.packetId);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, result: { merged: true } });
    expect(packet).toMatchObject({ releaseState: 'released', recovery: null });
  }, 60_000);

  it('routes a review-worthy surface approval to the recorded dispatcher and wakes the mission-ready rail', async () => {
    await updateOperatorDefaults({ requireApproval: 'surface' });
    const { lane, repo, baseHeadSha } = await createStandardLane('surface-risk', true, true);
    const dispatcherId = `thoughts-dispatcher-${Date.now()}`;
    const missionId = persistDispatcherMission(lane.packetId!, repo, dispatcherId);
    expect(await decideSurfaceMerge(lane, { passed: true, violations: [] })).toMatchObject({ surface: true });

    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });

    expect(result.ok).toBe(false);
    expect(result.approvalId).toBeTruthy();
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseHeadSha);
    const approval = listApprovalsForContext({ packetId: lane.packetId!, laneId: lane.id })
      .find((candidate) => candidate.id === result.approvalId);
    expect(approval).toMatchObject({
      status: 'pending',
      args: {
        approvalRoute: 'dispatcher',
        dispatcherSurface: 'orchestrator',
        dispatcherId,
      },
    });
    expect(listApprovals({ status: 'pending', projectId: null }).some((candidate) => candidate.id === result.approvalId)).toBe(false);
    expect(publishRealtimeMutation).toHaveBeenCalledWith(expect.objectContaining({
      sessionKeys: [dispatcherId],
      refreshTargets: expect.not.arrayContaining(['mobileInbox']),
    }));

    const wake = await handleWaitForMissionReady(
      { missionId, packetId: lane.packetId!, timeoutMs: 1_000 },
      getMissionStatus,
    );
    expect(wake.isError).not.toBe(true);
    const wakeText = wake.content.find((entry) => entry.type === 'text');
    expect(wakeText?.type).toBe('text');
    expect(JSON.parse(wakeText!.text)).toMatchObject({
      wakeReason: 'already-terminal',
      terminalPacketId: lane.packetId,
    });
  }, 30_000);

  it('keeps an operator-routed dispatcher approval visible in the operator inbox', async () => {
    await updateOperatorDefaults({ requireApproval: 'surface' });
    const operator = await createStandardLane('surface-risk-operator', true, true);
    persistDispatcherMission(
      operator.lane.packetId!,
      operator.repo,
      'cli',
      { dispatcher: { surface: 'operator', id: 'cli' } },
    );

    const result = await dispatch({
      verb: 'merge',
      laneId: operator.lane.id,
      actor: 'orchestrator',
    });

    expect(result.ok).toBe(false);
    expect(result.approvalId).toBeTruthy();
    expect(listApprovals({ status: 'pending', projectId: null }).some((candidate) => (
      candidate.id === result.approvalId
    ))).toBe(true);

    getSqlite().prepare(
      'UPDATE approvals SET created_at = ? WHERE id = ?',
    ).run(Date.now() - 31 * 60 * 1000, result.approvalId);

    expect(expireStaleApprovals()).toBe(0);
    expect(getApproval(result.approvalId!)).toMatchObject({ status: 'pending' });

    archiveLane(operator.lane.id, 'system');
    expect(expireStaleApprovals()).toBe(1);
    expect(getApproval(result.approvalId!)).toMatchObject({ status: 'rejected' });
  }, 30_000);

  it('merges an easy high-confidence packet in the loop under surface posture', async () => {
    await updateOperatorDefaults({ requireApproval: 'surface' });
    const { lane, repo, reviewedHeadSha } = await createStandardLane('surface-easy');
    persistDispatcherMission(lane.packetId!, repo, `thoughts-easy-${Date.now()}`);

    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });

    expect(result.ok).toBe(true);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(reviewedHeadSha);
    expect(listApprovalsForContext({ laneId: lane.id }).some((candidate) => (
      candidate.status === 'pending' && candidate.policyRuleId === 'surface-dispatcher-review'
    ))).toBe(false);
  }, 30_000);
  it('persists always, creates a lane-merge ApprovalRecord, and leaves the standard diff unmerged', async () => {
    await updateOperatorDefaults({ requireApproval: 'always' });
    const { lane, repo, baseHeadSha } = await createStandardLane('always');

    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });

    expect(result.ok).toBe(false);
    expect(result.approvalId).toBeTruthy();
    expect(getLane(lane.id)?.status).toBe('awaiting_input');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseHeadSha);
    const approval = listApprovalsForContext({
      packetId: lane.packetId ?? undefined,
      laneId: lane.id,
      sessionKey: lane.sessionKey ?? undefined,
    }).find((candidate) => candidate.id === result.approvalId);
    expect(approval).toMatchObject({
      status: 'pending',
      policyRuleId: 'lane-merge',
      continuation: {
        kind: 'lane',
        laneId: lane.id,
        verb: 'merge',
      },
    });
  }, 30_000);

  it('rejects stale spoken-review evidence before resolving a lane merge approval', async () => {
    await updateOperatorDefaults({ requireApproval: 'always' });
    const { lane, repo, baseHeadSha } = await createStandardLane('stale-spoken-receipt');

    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    const approval = listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === result.approvalId);
    expect(approval).toMatchObject({ status: 'pending', policyRuleId: 'lane-merge' });

    const reviewResponse = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(lane.packetId!)}&spoken=1&approvalId=${encodeURIComponent(approval!.id)}`,
      { headers: { host: 'localhost:3001' } },
    ));
    const reviewPayload = await reviewResponse.json();
    const reviewedEvidence = reviewPayload.spokenReview.evidence;
    expect(reviewedEvidence).toMatchObject({
      headSha: expect.any(String),
      fingerprint: expect.any(String),
      governanceFingerprint: expect.any(String),
    });

    writeFileSync(join(lane.worktreePath!, 'changed-after-speaking.txt'), 'new evidence\n');
    const mutationResponse = await approvalsRoute.POST(new NextRequest(
      'http://localhost:3001/api/panel/approvals',
      {
        method: 'POST',
        headers: {
          host: 'localhost:3001',
          authorization: `Bearer ${getOrCreateWsToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'approve',
          id: approval!.id,
          spokenReviewEvidence: {
            approvalId: approval!.id,
            packetId: lane.packetId,
            reviewedHeadSha: reviewedEvidence.headSha,
            reviewedDiffFingerprint: reviewedEvidence.fingerprint,
            reviewedGovernanceFingerprint: reviewedEvidence.governanceFingerprint,
          },
        }),
      },
    ));
    const mutationPayload = await mutationResponse.json();

    expect(mutationResponse.status).toBe(409);
    expect(mutationPayload).toMatchObject({ ok: false, code: 'spoken_review_changed' });
    expect(listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === approval!.id)?.status).toBe('pending');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseHeadSha);
  }, 30_000);

  it('resolves and merges the exact packet after a current spoken review', async () => {
    await updateOperatorDefaults({ requireApproval: 'always' });
    const { lane, repo, reviewedHeadSha } = await createStandardLane('current-spoken-receipt');
    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    const approval = listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === result.approvalId)!;
    const reviewResponse = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(lane.packetId!)}&spoken=1&approvalId=${encodeURIComponent(approval.id)}`,
      { headers: { host: 'localhost:3001' } },
    ));
    const evidence = (await reviewResponse.json()).spokenReview.evidence;

    const response = await approvalsRoute.POST(new NextRequest(
      'http://localhost:3001/api/panel/approvals',
      {
        method: 'POST',
        headers: {
          host: 'localhost:3001',
          authorization: `Bearer ${getOrCreateWsToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'approve',
          id: approval.id,
          spokenReviewEvidence: {
            approvalId: approval.id,
            packetId: lane.packetId,
            reviewedHeadSha: evidence.headSha,
            reviewedDiffFingerprint: evidence.fingerprint,
            reviewedGovernanceFingerprint: evidence.governanceFingerprint,
          },
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, resolved: 'approve' });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(reviewedHeadSha);
    expect(listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === approval.id)?.status).toBe('approved');
  }, 30_000);

  it('pushes the exact packet and opens a PR after a current spoken review', async () => {
    await updateOperatorDefaults({ requireApproval: 'always' });
    const { lane, repo, reviewedHeadSha } = await createStandardLane('current-spoken-pr');
    const result = await dispatch({ verb: 'create_pr', laneId: lane.id, actor: 'orchestrator' });
    const approval = listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === result.approvalId)!;
    const reviewResponse = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(lane.packetId!)}&spoken=1&approvalId=${encodeURIComponent(approval.id)}`,
      { headers: { host: 'localhost:3001' } },
    ));
    const evidence = (await reviewResponse.json()).spokenReview.evidence;
    const fakeBin = mkdtempSync(join(os.tmpdir(), 'o8-spoken-pr-bin-'));
    tempDirs.push(fakeBin);
    const fakeGh = join(fakeBin, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\nprintf "%s\\n" "https://github.com/hurttlocker/o8/pull/1218"\n');
    chmodSync(fakeGh, 0o755);
    const previousPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeBin}:${previousPath}`;

    try {
      const response = await approvalsRoute.POST(new NextRequest(
        'http://localhost:3001/api/panel/approvals',
        {
          method: 'POST',
          headers: {
            host: 'localhost:3001',
            authorization: `Bearer ${getOrCreateWsToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            action: 'approve',
            id: approval.id,
            spokenReviewEvidence: {
              approvalId: approval.id,
              packetId: lane.packetId,
              reviewedHeadSha: evidence.headSha,
              reviewedDiffFingerprint: evidence.fingerprint,
              reviewedGovernanceFingerprint: evidence.governanceFingerprint,
            },
          }),
        },
      ));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, resolved: 'approve' });
    } finally {
      process.env.PATH = previousPath;
    }

    expect(git(repo, ['rev-parse', `origin/${lane.branch}`])).toBe(reviewedHeadSha);
    expect(getLane(lane.id)).toMatchObject({ status: 'reviewing', outcome: 'pr_opened' });
  }, 30_000);

  it('keeps a receipted approval pending when the request changes merge strategy', async () => {
    await updateOperatorDefaults({ requireApproval: 'always' });
    const { lane } = await createStandardLane('spoken-strategy-change');
    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    const approval = listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === result.approvalId)!;
    const reviewResponse = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(lane.packetId!)}&spoken=1&approvalId=${encodeURIComponent(approval.id)}`,
      { headers: { host: 'localhost:3001' } },
    ));
    const evidence = (await reviewResponse.json()).spokenReview.evidence;

    const response = await approvalsRoute.POST(new NextRequest(
      'http://localhost:3001/api/panel/approvals',
      {
        method: 'POST',
        headers: {
          host: 'localhost:3001',
          authorization: `Bearer ${getOrCreateWsToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'approve',
          id: approval.id,
          strategy: 'ours',
          spokenReviewEvidence: {
            approvalId: approval.id,
            packetId: lane.packetId,
            reviewedHeadSha: evidence.headSha,
            reviewedDiffFingerprint: evidence.fingerprint,
            reviewedGovernanceFingerprint: evidence.governanceFingerprint,
          },
        }),
      },
    ));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'spoken_review_changed',
    });
    expect(listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === approval.id)?.status).toBe('pending');
  }, 30_000);

  it('rejects a changed merge strategy again at the lane execution boundary', async () => {
    await updateOperatorDefaults({ requireApproval: 'always' });
    const { lane, repo, baseHeadSha } = await createStandardLane('execution-strategy-change');
    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    const approval = listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === result.approvalId)!;
    const reviewResponse = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(lane.packetId!)}&spoken=1&approvalId=${encodeURIComponent(approval.id)}`,
      { headers: { host: 'localhost:3001' } },
    ));
    const evidence = (await reviewResponse.json()).spokenReview.evidence;
    const reviewedLaneStatus = getLane(lane.id)!.status;
    const claim = claimApprovalResolution(
      approval.id,
      'approve',
      'desktop',
      undefined,
      approval.updatedAt,
    );

    const mutation = await dispatch({
      verb: 'merge',
      laneId: lane.id,
      actor: 'user',
      strategy: 'ours',
      expectedHeadSha: evidence.headSha,
      expectedDiffFingerprint: evidence.fingerprint,
      expectedGovernanceFingerprint: evidence.governanceFingerprint,
      spokenReviewApprovalId: approval.id,
      spokenReviewClaimId: claim.claimId,
      spokenReviewUpdatedAt: approval.updatedAt,
      spokenReviewLaneStatus: reviewedLaneStatus,
    });

    expect(mutation).toMatchObject({
      ok: false,
      reason: 'governance_changed_since_spoken_review',
    });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseHeadSha);
  }, 30_000);

  it('rejects a spoken receipt when review findings change without a Git change', async () => {
    await updateOperatorDefaults({ requireApproval: 'always' });
    const { lane, reviewedHeadSha } = await createStandardLane('stale-governance');
    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    const approval = listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === result.approvalId)!;
    const reviewResponse = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(lane.packetId!)}&spoken=1&approvalId=${encodeURIComponent(approval.id)}`,
      { headers: { host: 'localhost:3001' } },
    ));
    const reviewPayload = await reviewResponse.json();
    const evidence = reviewPayload.spokenReview.evidence;

    recordOrchestratorReview(lane.packetId!, {
      approved: false,
      findings: [{
        file: 'file.txt',
        severity: 'bug',
        description: 'A new blocking finding arrived after speech.',
        resolution: 'deferred',
      }],
      reviewer: 'codex',
      reviewedHeadSha,
      requiresSecondPass: true,
    });
    const response = await approvalsRoute.POST(new NextRequest(
      'http://localhost:3001/api/panel/approvals',
      {
        method: 'POST',
        headers: {
          host: 'localhost:3001',
          authorization: `Bearer ${getOrCreateWsToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'approve',
          id: approval.id,
          spokenReviewEvidence: {
            approvalId: approval.id,
            packetId: lane.packetId,
            reviewedHeadSha: evidence.headSha,
            reviewedDiffFingerprint: evidence.fingerprint,
            reviewedGovernanceFingerprint: evidence.governanceFingerprint,
          },
        }),
      },
    ));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'spoken_review_changed',
    });
    expect(listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === approval.id)?.status).toBe('pending');
  }, 30_000);

  it('rechecks governance after waiting for the repository publication lock', async () => {
    await updateOperatorDefaults({ requireApproval: 'always' });
    const { lane, repo, reviewedHeadSha, baseHeadSha } = await createStandardLane('locked-governance');
    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    const approval = listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === result.approvalId)!;
    const reviewResponse = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(lane.packetId!)}&spoken=1&approvalId=${encodeURIComponent(approval.id)}`,
      { headers: { host: 'localhost:3001' } },
    ));
    const evidence = (await reviewResponse.json()).spokenReview.evidence;

    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve; });
    const blocker = withRepoActionLock(repo, async () => lockHeld);
    const responsePromise = approvalsRoute.POST(new NextRequest(
      'http://localhost:3001/api/panel/approvals',
      {
        method: 'POST',
        headers: {
          host: 'localhost:3001',
          authorization: `Bearer ${getOrCreateWsToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'approve',
          id: approval.id,
          spokenReviewEvidence: {
            approvalId: approval.id,
            packetId: lane.packetId,
            reviewedHeadSha: evidence.headSha,
            reviewedDiffFingerprint: evidence.fingerprint,
            reviewedGovernanceFingerprint: evidence.governanceFingerprint,
          },
        }),
      },
    ));

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (listApprovalsForContext({ laneId: lane.id })
        .find((candidate) => candidate.id === approval.id)?.status === 'approved') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === approval.id)?.status).toBe('approved');
    recordOrchestratorReview(lane.packetId!, {
      approved: false,
      findings: [{
        file: 'file.txt',
        severity: 'bug',
        description: 'Finding arrived while publication waited for the repository lock.',
        resolution: 'deferred',
      }],
      reviewer: 'codex',
      reviewedHeadSha,
      requiresSecondPass: true,
    });
    releaseLock();
    await blocker;
    const response = await responsePromise;

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, code: 'spoken_review_changed' });
    expect(listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === approval.id)?.status).toBe('pending');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseHeadSha);
  }, 30_000);

  it('rejects late diff drift again at the final user merge boundary', async () => {
    const { lane, repo, baseHeadSha, reviewedHeadSha } = await createStandardLane('late-spoken-drift');
    await updateOperatorDefaults({ requireApproval: 'always' });
    const approvalResult = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    const approval = listApprovalsForContext({ laneId: lane.id })
      .find((candidate) => candidate.id === approvalResult.approvalId)!;
    const reviewResponse = await reviewStateRoute.GET(new NextRequest(
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(lane.packetId!)}&spoken=1&approvalId=${encodeURIComponent(approval.id)}`,
      { headers: { host: 'localhost:3001' } },
    ));
    const evidence = (await reviewResponse.json()).spokenReview.evidence;
    const reviewedLaneStatus = getLane(lane.id)!.status;
    const claim = claimApprovalResolution(
      approval.id,
      'approve',
      'desktop',
      undefined,
      approval.updatedAt,
    );

    writeFileSync(join(lane.worktreePath!, 'late-untracked.txt'), 'arrived after route verification\n');
    const result = await dispatch({
      verb: 'merge',
      laneId: lane.id,
      actor: 'user',
      expectedHeadSha: reviewedHeadSha,
      expectedDiffFingerprint: evidence.fingerprint,
      expectedGovernanceFingerprint: evidence.governanceFingerprint,
      spokenReviewApprovalId: approval.id,
      spokenReviewClaimId: claim.claimId,
      spokenReviewUpdatedAt: approval.updatedAt,
      spokenReviewLaneStatus: reviewedLaneStatus,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'governance_changed_since_spoken_review',
    });
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseHeadSha);
  }, 30_000);

  it('fails closed when a caller supplies only part of the spoken evidence bundle', async () => {
    const { lane, repo, baseHeadSha } = await createStandardLane('partial-spoken-evidence');
    const result = await dispatch({
      verb: 'merge',
      laneId: lane.id,
      actor: 'user',
      expectedDiffFingerprint: 'partial-only',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'spoken_review_evidence_incomplete',
    });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseHeadSha);
  }, 30_000);

  it('keeps explicit high-risk mode on today\'s standard-diff auto-merge behavior', async () => {
    expect((await getOperatorDefaults()).values.requireApproval).toBe('high-risk');
    await updateOperatorDefaults({ requireApproval: 'high-risk' });
    const { lane, repo, reviewedHeadSha } = await createStandardLane('high-risk');

    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });

    expect(result.ok).toBe(true);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(reviewedHeadSha);
    expect(listApprovalsForContext({ laneId: lane.id }).some((candidate) => (
      candidate.status === 'pending' && candidate.policyRuleId === 'lane-merge'
    ))).toBe(false);
  }, 30_000);

  it('refuses an unreviewed orchestrator merge even when policy would auto-approve it', async () => {
    await updateOperatorDefaults({ requireApproval: 'never' });
    const { lane, repo, baseHeadSha } = await createStandardLane('never', false);

    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });

    expect(result).toMatchObject({
      ok: false,
      note: 'Merge refused: No durable approved AI review exists. Operator approval required.',
    });
    expect(result.approvalId).toBeTruthy();
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseHeadSha);
    expect(listApprovalsForContext({ laneId: lane.id })).toContainEqual(expect.objectContaining({
      id: result.approvalId,
      status: 'pending',
      policyRuleId: 'lane-merge',
    }));
  }, 30_000);
});
