import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const { publishRealtimeMutation } = vi.hoisted(() => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation }));
vi.mock('@/lib/worktree/safety-hooks', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/safety-hooks')>(),
  writeManagedWorkspaceSafetyHooks: vi.fn(async () => {}),
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

process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mcp-review-merge-freshness-'));
const token = 'vitest-review-merge-token-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, 'utf8');
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const reviewRoute = await import('@/app/api/orchestrator/review/route');
const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const { listApprovalsForContext } = await import('@/lib/approvals/store');
const { recordMission } = await import('@/lib/db/missions-store');
const { createLane, getLane, updateLane } = await import('@/lib/lane/registry');
const { startReviewTurn } = await import('@/lib/lane/review-turn-state');
const { handleApproveAndMerge } = await import('@/lib/mcp/operator-handlers/approve');
const { handleSubmitReview } = await import('@/lib/mcp/operator-handlers/mission');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getWorktreeManager } = await import('@/lib/worktree/launch');

const tempDirs: string[] = [];

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

function parseToolResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  expect(result.isError).not.toBe(true);
  const text = result.content.find((entry) => entry.type === 'text')?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text!) as Record<string, unknown>;
}

function parseToolError(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  expect(result.isError).toBe(true);
  const text = result.content.find((entry) => entry.type === 'text')?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text!) as Record<string, unknown>;
}

async function routeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const request = new NextRequest(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  });
  if (url.pathname === '/api/orchestrator/review') return reviewRoute.POST(request);
  if (url.pathname === '/api/orchestrator/merge') return mergeRoute.POST(request);
  throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url.pathname}`);
}

async function createFixture() {
  const root = mkdtempSync(join(os.tmpdir(), 'o8-mcp-review-merge-repo-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  const packetId = `pkt-review-merge-${Date.now()}`;
  const missionId = `mission-${packetId}`;
  const branch = `inline/review-merge-${Date.now()}`;
  tempDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);

  const worktree = await getWorktreeManager(repo).create({
    agentType: 'codex',
    taskName: packetId,
    branchName: branch,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
  writeFileSync(join(worktree.path, 'file.txt'), 'base\nreviewed change\n');
  commitAll(worktree.path, 'reviewed change');
  const reviewedHeadSha = git(worktree.path, ['rev-parse', 'HEAD']);
  const lane = createLane({
    repoPath: repo,
    worktreePath: worktree.path,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
    label: 'Fresh MCP review merge',
  });

  const packet: OrchestratorPacket = {
    id: packetId,
    referenceLabel: 'fresh-review',
    title: 'Fresh review',
    summary: 'Fresh review',
    workspaceTargetPath: repo,
    branchTarget: branch,
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
    orchestratorThreadId: `thoughts-${packetId}`,
    dispatcher: { surface: 'orchestrator', id: `thoughts-${packetId}` },
  };
  const missionState = normalizeOrchestratorMissionState({
    version: 2,
    missionId,
    prompt: 'Review then merge',
    summary: 'Review then merge',
    repoPath: repo,
    runtime: 'codex',
    constraints: '',
    packets: [packet],
    updatedAt: new Date().toISOString(),
  });
  recordMission({
    id: missionId,
    repoPath: repo,
    runtime: 'codex',
    prompt: missionState.prompt,
    summary: missionState.summary,
    constraints: '',
    packetMeta: [{ id: packetId, title: packet.title, referenceLabel: packet.referenceLabel }],
    missionState,
    totalWaves: 1,
  });
  writeOrchestratorControlPlaneState(missionState);

  return { lane, packetId, repo, reviewedHeadSha };
}

beforeEach(async () => {
  publishRealtimeMutation.mockClear();
  await updateOperatorDefaults({ requireApproval: 'surface' });
  vi.spyOn(globalThis, 'fetch').mockImplementation(routeFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('operator MCP review-to-merge freshness', () => {
  it.skipIf(process.platform !== 'linux')('merges and retires the owned worktree when Git is absent from PATH', async () => {
    const fixture = await createFixture();
    const worktreePath = fixture.lane.worktreePath!;
    const { readWorktreeMetaSnapshot } = await import('@/lib/worktree/metadata-store');
    const { bindOwnedPacketSession } = await import('./helpers/managed-packet-worktree');
    const metadata = Object.values(await readWorktreeMetaSnapshot(fixture.repo))
      .find((entry) => entry.packetId === fixture.packetId)!;
    const sessionKey = await bindOwnedPacketSession(fixture.repo, { id: metadata.id, path: worktreePath }, {
      packetId: fixture.packetId, branch: fixture.lane.branch,
    });
    updateLane(fixture.lane.id, { sessionKey }, 'system');
    await updateOperatorDefaults({ storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
    startReviewTurn({ laneId: fixture.lane.id, threadId: `review-${fixture.packetId}`, backend: 'codex', surface: 'auto-review' });
    parseToolResult(await handleSubmitReview({
      packetId: fixture.packetId, findings: [], approved: true, reviewedHeadSha: fixture.reviewedHeadSha,
    }));

    const previousPath = process.env.PATH;
    // Keep native process probes reachable; Git alone must resolve through a
    // supported absolute fallback, without inheriting a warm PATH lookup.
    const emptyPath = mkdtempSync(join(os.tmpdir(), 'o8-empty-git-path-'));
    tempDirs.push(emptyPath);
    for (const tool of ['ps', 'pgrep', 'lsof']) {
      const executable = (previousPath ?? '').split(delimiter).filter(isAbsolute)
        .map((directory) => join(directory, tool)).find(existsSync);
      expect(executable, `${tool} is required for real cleanup process probes`).toBeTruthy();
      symlinkSync(executable!, join(emptyPath, tool));
    }
    process.env.PATH = emptyPath;
    try {
      const merge = parseToolResult(await handleApproveAndMerge({
        packetId: fixture.packetId, expectedHeadSha: fixture.reviewedHeadSha,
      }));
      expect(merge, JSON.stringify(merge)).toMatchObject({ merged: true });
      expect(existsSync(worktreePath)).toBe(false);
      expect(getLane(fixture.lane.id)).toMatchObject({ outcome: 'merged', worktreePath: null });
      expect(Object.values(await readWorktreeMetaSnapshot(fixture.repo)))
        .not.toContainEqual(expect.objectContaining({ packetId: fixture.packetId }));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(fixture.reviewedHeadSha);
    expect(git(fixture.repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0]).toBe(fixture.reviewedHeadSha);
    expect(readOrchestratorControlPlaneState().packets.find((packet) => packet.id === fixture.packetId))
      .toMatchObject({ releaseState: 'released', status: 'released' });
  }, 60_000);

  it('merges from the review persisted by the immediately preceding submit_review', async () => {
    const fixture = await createFixture();
    const abbreviatedHeadSha = fixture.reviewedHeadSha.slice(0, 9);
    const reviewTurnId = startReviewTurn({
      laneId: fixture.lane.id,
      threadId: `auto-review-${fixture.lane.id}`,
      backend: 'codex',
      surface: 'auto-review',
    });

    const review = parseToolResult(await handleSubmitReview({
      packetId: fixture.packetId,
      findings: [],
      approved: true,
      reviewedHeadSha: abbreviatedHeadSha,
    }));
    expect(review).toMatchObject({ recorded: true, reviewedHeadSha: fixture.reviewedHeadSha });

    const persistedReview = listApprovalsForContext({
      packetId: fixture.packetId,
      laneId: fixture.lane.id,
    }).find((approval) => approval.toolName === 'orchestrator_review');
    expect(persistedReview).toMatchObject({
      status: 'approved',
      args: {
        reviewedHeadSha: fixture.reviewedHeadSha,
        reviewTurnId,
        reviewTurnOutcome: 'completed',
      },
    });

    const merge = parseToolResult(await handleApproveAndMerge({
      packetId: fixture.packetId,
      expectedHeadSha: fixture.reviewedHeadSha,
    }));
    expect(merge, JSON.stringify(merge)).toMatchObject({ merged: true });
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(fixture.reviewedHeadSha);
    expect(listApprovalsForContext({
      packetId: fixture.packetId,
      laneId: fixture.lane.id,
    })).not.toContainEqual(expect.objectContaining({
      status: 'pending',
      continuation: expect.objectContaining({ kind: 'lane', verb: 'merge' }),
    }));
    expect(readOrchestratorControlPlaneState().packets.find((packet) => (
      packet.id === fixture.packetId
    ))?.review?.reviewedHeadSha).toBe(fixture.reviewedHeadSha);
  }, 60_000);

  it('returns a structured error without persisting an unresolvable reviewed HEAD', async () => {
    const fixture = await createFixture();
    const unresolvableHeadSha = `${fixture.reviewedHeadSha[0] === 'f' ? 'e' : 'f'}${fixture.reviewedHeadSha.slice(1, 9)}`;

    const review = parseToolError(await handleSubmitReview({
      packetId: fixture.packetId,
      findings: [],
      approved: true,
      reviewedHeadSha: unresolvableHeadSha,
    }));

    expect(review).toMatchObject({
      recorded: false,
      reviewedHeadSha: null,
      code: 'unresolvable_reviewed_head_sha',
      ignoredReason: 'unresolvable_reviewed_head_sha',
    });
    expect(review.error).toContain(`reviewedHeadSha ${unresolvableHeadSha} does not resolve`);
    expect(listApprovalsForContext({
      packetId: fixture.packetId,
      laneId: fixture.lane.id,
    })).not.toContainEqual(expect.objectContaining({ toolName: 'orchestrator_review' }));

    const tooShort = parseToolError(await handleSubmitReview({
      packetId: fixture.packetId,
      findings: [],
      approved: true,
      reviewedHeadSha: 'abcdef',
    }));
    expect(tooShort).toMatchObject({
      recorded: false,
      code: 'invalid_reviewed_head_sha',
      ignoredReason: 'invalid_reviewed_head_sha',
    });
  }, 60_000);
});
