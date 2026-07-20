import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-merge-real-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { getLane, getLaneEvents, createLane } = await import('@/lib/lane/registry');
const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { steerPacket } = await import('@/lib/orchestrator/operator-mission-service/steer');
const typecheckAvailability = await import('@/lib/lane/typecheck-availability');
const runtimeActions = await import('@/lib/runtime/actions');
const { listApprovalsForContext, recordOrchestratorReview } = await import('@/lib/approvals/store');

const tempDirs: string[] = [dataDir];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
}

function makeRepo(name: string) {
  const root = mkdtempSync(join(os.tmpdir(), `${name}-root-`));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  tempDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);
  return { root: realpathSync(root), origin: realpathSync(origin), repo: realpathSync(repo) };
}

async function makeWorktree(repo: string, packetId: string, branch: string) {
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
  return worktree;
}

function mergeCommand(laneId: string) {
  return {
    verb: 'merge' as const,
    laneId,
    actor: 'system' as const,
    orchestratorReviewed: true,
  };
}

async function mergeLane(lane: ReturnType<typeof createLane>) {
  const approvals: Array<{ policyRuleId: string; note: string; metadata?: Record<string, string> }> = [];
  const result = await performWorktreeSideMerge({
    lane,
    command: mergeCommand(lane.id),
    actor: 'system',
    gateResult: { passed: true, violations: [] },
    createLaneActionApproval: async (_lane, _actor, input) => {
      approvals.push({
        policyRuleId: input.policyRuleId,
        note: input.note,
        metadata: input.metadata,
      });
      return { ok: false, laneId: lane.id, note: input.note };
    },
  });
  return { result, approvals };
}

function packetFixture(id: string, repoPath: string, retries = 0): OrchestratorPacket {
  return {
    id,
    referenceLabel: id,
    title: 'Typecheck packet',
    summary: 'Breaks tsc',
    status: 'running',
    queueState: 'held',
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 0,
    lastEventAt: null,
    lastEventLabel: null,
    recoveryCount: 0,
    typecheckAutoRetries: retries,
    workspaceTargetPath: repoPath,
    branchTarget: `inline/${id}`,
  } as OrchestratorPacket;
}

afterEach(() => {
  for (const dir of tempDirs.splice(1)) {
    rmSync(dir, { recursive: true, force: true });
  }
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
});

describe('worktree-side merge with real git repos', () => {
  it('fast-forwards the operator checkout from the worker worktree without checkout/stash detours', async () => {
    const { repo } = makeRepo('o8-merge-ff');
    const worktree = await makeWorktree(repo, 'pkt-ff', 'inline/ff');
    writeFileSync(join(worktree.path, 'file.txt'), 'base\nworker\n');
    commitAll(worktree.path, 'worker change');

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/ff',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-ff',
    });

    const { result, approvals } = await mergeLane(lane);

    expect(result.ok).toBe(true);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(repo, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(git(repo, ['stash', 'list'])).toBe('');
    expect(git(repo, ['show', 'HEAD:file.txt'])).toContain('worker');
    expect(getLane(lane.id)?.status).toBe('completed');
    expect(approvals).toEqual([]);
    expect(existsSync(worktree.path)).toBe(false);
  }, 20_000);

  it('escalates a dirty operator checkout instead of stashing or force-merging it', async () => {
    const { repo } = makeRepo('o8-merge-dirty');
    const worktree = await makeWorktree(repo, 'pkt-dirty', 'inline/dirty');
    writeFileSync(join(worktree.path, 'file.txt'), 'base\nworker\n');
    commitAll(worktree.path, 'worker change');
    writeFileSync(join(repo, 'file.txt'), 'base\noperator wip\n');

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/dirty',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-dirty',
    });

    const { result, approvals } = await mergeLane(lane);

    expect(result.ok).toBe(false);
    expect(approvals[0]?.policyRuleId).toBe('fast_forward_failure_escalation');
    expect(approvals[0]?.metadata?.FailureCategory).toBe('dirty-working-tree');
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(repo, ['status', '--porcelain'])).toContain('M file.txt');
    expect(git(repo, ['stash', 'list'])).toBe('');
    expect(git(repo, ['show', 'HEAD:file.txt'])).toBe('base');
    expect(getLane(lane.id)?.status).not.toBe('completed');
  }, 20_000);

  it('auto-rebases once when origin/main moves between rebase and final fast-forward', async () => {
    const { repo, origin, root } = makeRepo('o8-merge-base-moved');
    const worktree = await makeWorktree(repo, 'pkt-base-moved', 'inline/base-moved');
    writeFileSync(join(worktree.path, 'worker.txt'), 'worker\n');
    commitAll(worktree.path, 'worker change');

    const hookFlag = join(root, 'base-moved-once');
    const hook = join(repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, [
      '#!/bin/sh',
      `if [ ! -f "${hookFlag}" ]; then`,
      `  touch "${hookFlag}"`,
      '  tmp="$(mktemp -d)"',
      `  git clone "${origin}" "$tmp/repo" >/dev/null 2>&1`,
      '  cd "$tmp/repo" || exit 1',
      '  git checkout main >/dev/null 2>&1',
      '  git config user.name o8-test',
      '  git config user.email o8@example.test',
      '  printf "upstream\\n" > upstream.txt',
      '  git add upstream.txt',
      '  git commit -m "upstream moved" >/dev/null 2>&1',
      '  git push origin main >/dev/null 2>&1',
      'fi',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(hook, 0o755);

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: 'inline/base-moved',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-base-moved',
    });

    const { result, approvals } = await mergeLane(lane);

    expect(result.ok).toBe(true);
    expect(approvals).toEqual([]);
    expect(git(repo, ['show', 'HEAD:worker.txt'])).toBe('worker');
    expect(git(repo, ['show', 'HEAD:upstream.txt'])).toBe('upstream');
    expect(git(repo, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])).toBe('');
  }, 20_000);
});

describe('typecheck escalation counters through real merge attempts', () => {
  async function makeTypecheckFailureLane(packetId: string, retries: number) {
    const { repo } = makeRepo(`o8-merge-ts-${packetId}`);
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ['src/**/*.ts'],
    }, null, 2));
    execFileSync('mkdir', ['-p', join(repo, 'src')]);
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const ok: string = "base";\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    commitAll(repo, 'add ts project');
    git(repo, ['push', 'origin', 'main']);

    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      repoPath: repo,
      packets: [packetFixture(packetId, repo, retries)],
    });

    const worktree = await makeWorktree(repo, packetId, `inline/${packetId}`);
    const binDir = join(worktree.path, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const tscPath = join(binDir, 'tsc');
    writeFileSync(tscPath, [
      '#!/bin/sh',
      "echo \"src/broken.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\"",
      'exit 2',
      '',
    ].join('\n'));
    chmodSync(tscPath, 0o755);
    writeFileSync(join(worktree.path, 'src', 'broken.ts'), 'export const broken: string = 123;\n');
    commitAll(worktree.path, 'break typecheck');

    const lane = createLane({
      repoPath: repo,
      worktreePath: worktree.path,
      branch: `inline/${packetId}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: `codex-owned:${packetId}`,
    });
    return { repo, lane };
  }

  it('supersedes the durable review on layer-1 retry and bails when reset_packet has held the packet', async () => {
    const { lane } = await makeTypecheckFailureLane('pkt-typecheck-held', 0);
    recordOrchestratorReview('pkt-typecheck-held', {
      approved: true,
      findings: [],
      reviewedHeadSha: git(lane.worktreePath!, ['rev-parse', 'HEAD']),
    });
    const { result } = await mergeLane(lane);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const packet = readOrchestratorControlPlaneState().packets.find((p) => p.id === 'pkt-typecheck-held');
    const events = getLaneEvents(lane.id);
    expect(result.ok).toBe(false);
    expect(result.note).toContain('Auto-rerun dispatched');
    expect(packet?.queueState).toBe('held');
    expect(packet?.typecheckAutoRetries).toBe(1);
    expect(events.filter((event) => event.verb === 'typecheck_auto_retry')).toHaveLength(1);
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(listApprovalsForContext({ packetId: 'pkt-typecheck-held', laneId: lane.id })
      .find((approval) => approval.toolName === 'orchestrator_review')?.args)
      .toMatchObject({
        reviewSuperseded: true,
        reviewSupersededReason: 'Superseded by typecheck auto-rerun.',
      });
  }, 20_000);

  it('caps layer-1 at one retry and escalates the next failing merge to awaiting_orchestrator', async () => {
    const { lane } = await makeTypecheckFailureLane('pkt-typecheck-cap', 1);
    const { result } = await mergeLane(lane);
    const packet = readOrchestratorControlPlaneState().packets.find((p) => p.id === 'pkt-typecheck-cap');
    const events = getLaneEvents(lane.id);

    expect(result.ok).toBe(false);
    expect(result.note).toContain('Typecheck failed after 1 auto-retry');
    expect(packet?.typecheckAutoRetries).toBe(1);
    expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
    expect(events.some((event) =>
      event.verb === 'typecheck_escalation'
      && event.payload.reason === 'retry_exhausted'
    )).toBe(true);
  }, 20_000);
});

describe('retry budget and escalation branch invariants', () => {
  it('steers a warm parked packet, while packets without a session must fresh-redispatch', async () => {
    const performSpy = vi.spyOn(runtimeActions, 'performRuntimeAction').mockResolvedValue({
      ok: true,
      action: 'steer',
      surfaceId: 'codex-owned:warm-branch',
      sessionKey: 'codex-owned:warm-branch',
      runtime: 'codex',
      status: 'completed',
      note: 'steered',
    });

    try {
      const repo = mkdtempSync(join(os.tmpdir(), 'o8-steer-branch-repo-'));
      tempDirs.push(repo);
      git(repo, ['init', '-b', 'main']);
      writeOrchestratorControlPlaneState({
        ...createEmptyOrchestratorMissionState(),
        repoPath: repo,
        packets: [packetFixture('pkt-warm-branch', repo, 1)],
      });
      const warmLane = createLane({
        repoPath: repo,
        worktreePath: repo,
        branch: 'inline/warm-branch',
        baseBranch: 'main',
        runtime: 'codex',
        packetId: 'pkt-warm-branch',
        sessionKey: 'codex-owned:warm-branch',
      });

      await expect(steerPacket({
        packetId: 'pkt-warm-branch',
        message: 'fix the typecheck errors and proceed',
      })).resolves.toMatchObject({
        laneId: warmLane.id,
        note: 'Steered packet via warm session.',
      });

      const coldLane = createLane({
        repoPath: repo,
        branch: 'inline/cold-branch',
        baseBranch: 'main',
        runtime: 'codex',
        packetId: 'pkt-cold-branch',
      });
      writeOrchestratorControlPlaneState({
        ...readOrchestratorControlPlaneState(),
        packets: [
          ...readOrchestratorControlPlaneState().packets,
          packetFixture('pkt-cold-branch', repo, 1),
        ],
      });

      await expect(steerPacket({
        packetId: 'pkt-cold-branch',
        message: 'try warm steer',
      })).rejects.toThrow('use rerun_with_feedback instead');
      expect(getLane(warmLane.id)?.status).toBe('running');
      expect(getLane(coldLane.id)?.status).not.toBe('running');
    } finally {
      performSpy.mockRestore();
    }
  }, 20_000);

  it('never mocks the typecheck skip seam while allowing tests to assert it was reached', async () => {
    const repo = mkdtempSync(join(os.tmpdir(), 'o8-typecheck-skip-repo-'));
    tempDirs.push(repo);
    git(repo, ['init', '-b', 'main']);
    expect(await typecheckAvailability.detectTypecheckSkip(repo)).toEqual({
      skip: true,
      reason: 'no tsconfig.json (not a TypeScript project)',
    });
  });
});
