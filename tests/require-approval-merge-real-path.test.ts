import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { publishRealtimeMutation } = vi.hoisted(() => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation }));

process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const tempDirs: string[] = [];
const defaultsPath = join(process.env.CORTEX_IDE_DATA_DIR!, 'operator-defaults.json');

const { listApprovals, listApprovalsForContext, recordOrchestratorReview } = await import('@/lib/approvals/store');
const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const reviewRoute = await import('@/app/api/orchestrator/review/route');
const reviewStateRoute = await import('@/app/api/orchestrator/review-state/route');
const { getOrCreateLocalWorkerToken } = await import('@/lib/auth/worker-token');
const { recordMission } = await import('@/lib/db/missions-store');
const { dispatch } = await import('@/lib/lane/commands');
const { decideSurfaceMerge } = await import('@/lib/lane/surface-merge-decision');
const { archiveLane, createLane, getLane } = await import('@/lib/lane/registry');
const { handleWaitForMissionReady } = await import('@/lib/mcp/operator-handlers/mission');
const { getOperatorDefaults, updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');
const { withControlPlaneLock, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { scanRepo } = await import('@/lib/skeleton');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
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
    ...Array.from({ length: 7 }, (_, index) => `export const expansion${index} = ${index};`),
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

function persistDispatcherMission(packetId: string, repoPath: string, orchestratorThreadId: string) {
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
    body: JSON.stringify({ packetId }),
  });
}

function reviewRequest(token: string, packetId: string, reviewedHeadSha: string): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/review', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      packetId,
      approved: true,
      reviewedHeadSha,
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
  publishRealtimeMutation.mockClear();
});

afterEach(() => {
  rmSync(defaultsPath, { force: true });
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('requireApproval merge governance through the real command path', () => {
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
      `http://localhost:3001/api/orchestrator/review-state?packetId=${encodeURIComponent(gated.lane.packetId!)}`,
      { headers: { host: 'localhost:3001' } },
    ));
    const reviewPayload = await reviewResponse.json();
    expect(reviewPayload.recovery).toMatchObject({
      preservedRef,
      preservedHeadSha: gated.reviewedHeadSha,
    });

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
    const workerResponse = await mergeRoute.POST(mergeRequest(getOrCreateLocalWorkerToken(), worker.lane.packetId!));
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

  it('lets never mode run a standard merge without a durable review card', async () => {
    await updateOperatorDefaults({ requireApproval: 'never' });
    const { lane, repo } = await createStandardLane('never', false);

    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });

    expect(result.ok).toBe(true);
    expect(git(repo, ['show', 'HEAD:file.txt'])).toContain('standard change');
    expect(listApprovalsForContext({ laneId: lane.id })).toHaveLength(0);
  }, 30_000);
});
