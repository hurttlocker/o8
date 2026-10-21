import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-independent-review-'));
process.env.O8_DATA_DIR = path.join(root, 'data');
process.env.CORTEX_IDE_DATA_DIR = process.env.O8_DATA_DIR;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(root, 'owned-codex');

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/auth/principal', () => ({
  resolveRequestPrincipal: () => 'operator',
  resolveRequestPrincipalContext: () => ({ role: 'operator' }),
  workerPacketRefusal: () => null,
}));
vi.mock('@/lib/lane/blind-second-pass-review', () => ({
  rearmPendingSecondPassApproval: vi.fn(async () => ({ rearmed: false, reason: 'Second pass pending.' })),
}));
// Keep host-wide process enumeration deterministic; session binding, retained-run
// accounting, quiescence synthesis, Git, lifecycle locks and SQLite remain real.
vi.mock('@/lib/runtime/process-cwd-snapshot', async (original) => ({
  ...await original<typeof import('@/lib/runtime/process-cwd-snapshot')>(),
  readProcessCwdSnapshot: vi.fn(async () => ({ status: 'ready', rows: [], capturedAt: Date.now() })),
}));

const review = await import('@/app/api/orchestrator/review/route');
const workspace = await import('@/app/api/orchestrator/workspace/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, findLatestLaneByPacket, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { addRepo } = await import('@/lib/repos/registry');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { listApprovalsForContext, supersedeOrchestratorReviewApprovals, finalizeOrchestratorReviewTurn } = await import('@/lib/approvals/store');
const { acquireWorkspaceRetentionHold, getWorkspaceRetentionHold } = await import('@/lib/workspace/retention-holds');
const { startReviewTurn } = await import('@/lib/lane/review-turn-state');
const { withLockedState } = await import('@/lib/orchestrator/control-plane');
const { synthesizePacketFromLane } = await import('@/lib/orchestrator/synthesize-packet');
const processProbes = await import('@/lib/workspace/process-probes');
const probeProcesses = processProbes.probeOwnedSessionProcessQuiescence;
const processCwd = await import('@/lib/runtime/process-cwd-snapshot');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

let serial = 0;
async function fixture(changedPath = 'RECOVERY.md', ownership: 'managed' | 'attached' = 'managed') {
  const packetId = `independent-review-${++serial}`;
  const repoPath = path.join(root, packetId);
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'test@example.test');
  git(repoPath, 'config', 'user.name', 'test');
  writeFileSync(path.join(repoPath, 'RECOVERY.md'), 'base\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-qm', 'base');
  const repo = await addRepo(repoPath);
  const worktreeId = `packet-${packetId}`;
  const branch = `inline/${packetId}`;
  const base = resolveWorktreeRootLayout(repo.localPath).primaryBase;
  const worktreePath = path.join(base, worktreeId);
  mkdirSync(base, { recursive: true });
  git(repo.localPath, 'worktree', 'add', '-qb', branch, worktreePath, 'main');
  mkdirSync(path.dirname(path.join(worktreePath, changedPath)), { recursive: true });
  writeFileSync(path.join(worktreePath, changedPath), 'reviewed change\n');
  git(worktreePath, 'add', '.');
  git(worktreePath, 'commit', '-qm', 'reviewed');
  const head = git(worktreePath, 'rev-parse', 'HEAD');
  const surfaceId = `codex-owned:codex-owned-${packetId}`;
  const identity = await captureWorktreeMaterializationIdentity(worktreePath);
  writeFileSync(path.join(base, '.meta.json'), JSON.stringify({ version: 1, worktrees: {
    [worktreeId]: { id: worktreeId, agentType: 'codex', sessionKey: surfaceId, baseBranch: 'main',
      createdAt: Date.now(), claudeManaged: false, taskName: packetId, branchName: branch,
      status: 'ready', isolationKind: 'git-worktree', materializationIdentity: identity,
      materializationParentIdentity: await captureWorktreeMaterializationIdentity(base) },
  } }));
  const sessionDir = path.join(process.env.CORTEX_IDE_OWNED_CODEX_ROOT!, `codex-owned-${packetId}`);
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, 'session.json');
  writeFileSync(sessionPath, JSON.stringify({
    surfaceId, packetId, sessionDir, cwd: worktreePath, repoPath: worktreePath, branch, head,
    title: 'Independent review fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    latestPrompt: '', latestSummary: '', recentRuns: [],
    runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
    workspaceBinding: { logicalWorkspaceId: `packet:${packetId}`, repositoryUuid: repo.id,
      packetId, cwd: worktreePath, version: 1, verifiedAt: new Date().toISOString() },
  }));
  const lane = createLane({ repoPath: repo.localPath, worktreePath, branch, baseBranch: 'main',
    runtime: 'codex', packetId, sessionKey: surfaceId, ownership });
  setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', 'review_queue_failed');
  getSqlite().prepare(`INSERT INTO review_queue (id, lane_id, repo_path, status, attempts, last_error, head_sha)
    VALUES (?, ?, ?, 'failed', 5, 'Reviewer unavailable', ?)`).run(`review-${packetId}`, lane.id, repo.localPath, head);
  return { packetId, repo, worktreePath, worktreeId, sessionPath, lane, head, identity };
}

async function submit(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  const response = await review.POST(new NextRequest('http://localhost/api/orchestrator/review', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packetId: f.packetId, approved: true, findings: [],
      reviewedHeadSha: f.head, clientMutationId: `${f.packetId}-review`, ...overrides }),
  }));
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.result.recorded).toBe(true);
  return body.result;
}

async function eligibility(packetId: string) {
  const response = await workspace.GET(new NextRequest(`http://localhost/api/orchestrator/workspace?packetId=${packetId}`));
  expect(response.status).toBe(200);
  return (await response.json()).result;
}

afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

describe('independent review repairs failed review workspace eligibility', () => {
  it('persists the exact approved transition and preserves failure evidence through the real routes', async () => {
    const f = await fixture();
    expect((await eligibility(f.packetId)).canPark).toBe(false);
    const result = await submit(f);
    expect(result.workspaceReconciliation, JSON.stringify(result)).toMatchObject({ status: 'reviewing' });
    closeDb();
    expect(findLatestLaneByPacket(f.packetId)?.status).toBe('reviewing');
    expect((await eligibility(f.packetId)).canPark).toBe(true);
    expect(listApprovalsForContext({ packetId: f.packetId }).find(x => x.id === result.auditApprovalId))
      .toMatchObject({ status: 'approved', args: { reviewedHeadSha: f.head, reviewTurnOutcome: 'completed' } });
    expect(getLaneEvents(f.lane.id).some(x => x.payload.eventLabel === 'review_queue_failed')).toBe(true);
    expect(git(f.worktreePath, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(git(f.worktreePath, 'status', '--porcelain')).toBe('');
    expect(JSON.parse(readFileSync(f.sessionPath, 'utf8')).recentRuns).toEqual([]);
    expect(getSqlite().prepare('SELECT status, attempts, last_error FROM review_queue WHERE lane_id = ?').get(f.lane.id))
      .toEqual({ status: 'failed', attempts: 5, last_error: 'Reviewer unavailable' });
  }, 30_000);

  it.each(['dirty', 'untracked', 'drifted', 'held', 'retention', 'running', 'other-blocker',
    'attached', 'wrong-binding', 'active-session', 'unknown-processes', 'active-review',
    'rejected', 'second-pass', 'implicit-head', 'unresolved-findings', 'unknown-filesystem'])(
    'does not grant workspace eligibility for %s', async (kind) => {
      const f = await fixture(kind === 'second-pass' ? 'src/lib/db/schema.ts' : 'RECOVERY.md',
        kind === 'attached' ? 'attached' : 'managed');
      const overrides: Record<string, unknown> = {};
      if (kind === 'dirty') writeFileSync(path.join(f.worktreePath, 'RECOVERY.md'), 'unreviewed\n');
      if (kind === 'untracked') writeFileSync(path.join(f.worktreePath, 'extra.txt'), 'unreviewed\n');
      if (kind === 'drifted') {
        writeFileSync(path.join(f.worktreePath, 'RECOVERY.md'), 'later commit\n');
        git(f.worktreePath, 'add', '.'); git(f.worktreePath, 'commit', '-qm', 'later');
      }
      if (kind === 'held') await withLockedState(state => {
        state.packets.push({ ...synthesizePacketFromLane(f.packetId, f.lane),
          queueState: 'held', holdIntent: 'operator' });
      });
      if (kind === 'retention') acquireWorkspaceRetentionHold({
        repositoryPath: f.repo.localPath, repositoryUuid: f.repo.id, worktreeId: f.worktreeId,
        packetId: f.packetId, laneId: f.lane.id, identity: f.identity,
        holdId: `hold-${f.packetId}`, reason: 'Preserve this task.',
      });
      if (kind === 'running') setLaneStatus(f.lane.id, 'running');
      if (kind === 'other-blocker') setLaneStatus(f.lane.id, 'awaiting_orchestrator', 'system', 'operator_hold');
      if (['wrong-binding', 'active-session', 'unknown-processes'].includes(kind)) {
        const session = JSON.parse(readFileSync(f.sessionPath, 'utf8'));
        if (kind === 'wrong-binding') session.workspaceBinding.packetId = 'different-packet';
        if (kind === 'unknown-processes') session.runIdentityLedger.complete = false;
        if (kind === 'active-session') session.activeRun = {
          id: 'live-run', mode: 'launch', prompt: '', startedAt: new Date().toISOString(),
          pid: process.pid, outcome: 'running', stdoutPath: '', stderrPath: '',
        };
        writeFileSync(f.sessionPath, JSON.stringify(session));
      }
      if (kind === 'active-review') startReviewTurn({
        laneId: f.lane.id, threadId: 'active-review', backend: 'codex', surface: 'auto-review', expectedHeadSha: f.head,
      });
      if (kind === 'rejected') overrides.approved = false;
      if (kind === 'implicit-head') overrides.reviewedHeadSha = undefined;
      if (kind === 'unknown-filesystem') vi.mocked(processCwd.readProcessCwdSnapshot).mockResolvedValueOnce({
        status: 'unavailable', rows: [], capturedAt: Date.now(), reason: 'Process enumeration unavailable.',
      });
      if (kind === 'unresolved-findings') overrides.findings = [{
        file: 'RECOVERY.md', severity: 'bug', description: 'Unresolved defect', resolution: 'deferred',
      }];
      const before = findLatestLaneByPacket(f.packetId)!;
      await submit(f, overrides);
      closeDb();
      expect(findLatestLaneByPacket(f.packetId)).toMatchObject({ status: before.status, lastEventLabel: before.lastEventLabel });
      expect((await eligibility(f.packetId)).canPark).toBe(false);
      if (kind === 'retention') expect(getWorkspaceRetentionHold(f.worktreePath, f.identity)?.releasedAt).toBeNull();
    }, 30_000,
  );

  it.each([true, false])('requires complete sealed contract coverage (provided=%s)', async (covered) => {
    const f = await fixture();
    await withLockedState(state => {
      state.packets.push({ ...synthesizePacketFromLane(f.packetId, f.lane), queueState: 'queued',
        taskContractRequired: true, taskContractSource: 'explicit', taskContract: {
          version: 1, requirements: [{ id: 'R1', source: 'Document recovery', expectedBehavior: 'Explain recovery',
            productionPath: 'RECOVERY.md', verification: 'Read the document' }],
          smallestRoute: [{ path: 'RECOVERY.md', requirements: ['R1'], reason: 'Documentation only' }], exclusions: [],
        } });
    });
    const result = await submit(f, covered ? { contractCoverageEvidence: {
      contractVersion: 1, headSha: f.head,
      entries: [{ requirementId: 'R1', productionPath: 'RECOVERY.md', verification: 'Read committed document' }],
    } } : {});
    expect(result.contractCoverage.status).toBe(covered ? 'passed' : 'failed');
    closeDb();
    expect((await eligibility(f.packetId)).canPark, JSON.stringify(result)).toBe(covered);
  }, 30_000);

  it.each(['superseded', 'failed-verdict', 'new-lifecycle-intent'])(
    'refuses a %s arriving during workspace verification', async (kind) => {
      const f = await fixture();
      vi.spyOn(processProbes, 'probeOwnedSessionProcessQuiescence').mockImplementationOnce(async (...args) => {
        const receipt = await probeProcesses(...args);
        if (kind === 'superseded') supersedeOrchestratorReviewApprovals(f.packetId, 'New review required');
        if (kind === 'failed-verdict') {
          const approval = listApprovalsForContext({ packetId: f.packetId })[0]!;
          finalizeOrchestratorReviewTurn(String(approval.args?.reviewTurnId), 'failed');
        }
        if (kind === 'new-lifecycle-intent') setLaneStatus(f.lane.id, 'paused', 'user', 'operator_hold');
        return receipt;
      });
      await submit(f);
      closeDb();
      expect(findLatestLaneByPacket(f.packetId)?.status).not.toBe('reviewing');
      expect((await eligibility(f.packetId)).canPark).toBe(false);
    }, 30_000,
  );
});
