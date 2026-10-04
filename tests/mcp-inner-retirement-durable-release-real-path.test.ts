import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket, PacketTaskContract } from '@/lib/orchestrator/types';
import type { McpToolResult } from '@/lib/mcp/operator-handlers/shared';
import { resolveTsxProcess } from '@/lib/testing/tsx-process';

// No runtime/provider turn is launched. The authoritative automatic-review turn
// is completed by the actual MCP submit_review request over the fixture HTTP API.
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/worktree/storage-telemetry', async (original) => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-inner-release-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = join(dataDir, 'worktrees');
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
writeFileSync(join(dataDir, 'ws-token'), 'fixture-inner-release-token-0123456789\n');

vi.resetModules();

const { getSqlite, closeDb } = await import('@/lib/db');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { startReviewTurn } = await import('@/lib/lane/review-turn-state');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { addRepo } = await import('@/lib/repos/registry');
const { recordMission } = await import('@/lib/db/missions-store');
const { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState, syncOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { persistMissionRegistryState, readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { handleSubmitReview } = await import('@/lib/mcp/operator-handlers/mission');
const { handleApproveAndMerge } = await import('@/lib/mcp/operator-handlers/approve');
const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const children: ChildProcessWithoutNullStreams[] = [];

const childScript = String.raw`
void (async () => {
  const fs = await import('node:fs');
  const load = async (path) => { const m = await import(path); return m.default ?? m; };
  const { WorktreeManager } = await load('./src/lib/worktree/manager.ts');
  const { readMissionRegistryEntry } = await load('./src/lib/orchestrator/mission-registry.ts');
  const opts = JSON.parse(process.env.O8_TEST_INNER_RELEASE);
  const cleanup = WorktreeManager.prototype.cleanup;
  WorktreeManager.prototype.cleanup = async function(id, options) {
    if (options?.workspaceRetirementAction !== 'merge') return cleanup.call(this, id, options);
    fs.writeFileSync(opts.before, JSON.stringify(readMissionRegistryEntry(opts.missionId, {includeArchived:true})));
    const result = await cleanup.call(this, id, options);
    fs.writeFileSync(opts.after, 'retired');
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(opts.resume) && Date.now() < deadline) await new Promise(r => setTimeout(r,20));
    if (!fs.existsSync(opts.resume)) throw new Error('fixture retirement resume timed out');
    return result;
  };
  const { NextRequest } = await load('next/server');
  const cp = await load('./src/lib/orchestrator/control-plane.ts');
  const review = await load('./src/app/api/orchestrator/review/route.ts');
  const merge = await load('./src/app/api/orchestrator/merge/route.ts');
  const status = await load('./src/app/api/orchestrator/status/route.ts');
  const { createServer } = await import('node:http');
  const server = createServer(async (req,res) => {
    try {
      let body='';for await(const chunk of req) body+=chunk;
      const request = new NextRequest('http://127.0.0.1:'+server.address().port+req.url, {
        method:req.method,headers:{...req.headers,'x-o8-client-addr':'127.0.0.1'},
        ...(req.method==='GET'?{}:{body}),
      });
      const route = req.url==='/api/orchestrator/review' ? review : merge;
      const response = req.method==='GET' ? await status.GET(request) : await route.POST(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    } catch(error) {res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
  });
  server.listen(0,'127.0.0.1',()=>fs.writeFileSync(opts.port,String(server.address().port)));
})().catch(error=>{console.error(error);process.exitCode=1;});
`;

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}
function tool(result: McpToolResult) {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content.find((item) => item.type === 'text')?.text ?? '{}');
}
async function waitFor(path: string) {
  const deadline = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`fixture signal missing: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function owner(missionId: string) {
  return readMissionRegistryEntry(missionId, { includeArchived: true })!;
}
const contract: PacketTaskContract = { version: 1,
  requirements: [{ id: 'R1', source: 'Write quick start', expectedBehavior: 'Exact two lines',
    productionPath: 'QUICKSTART.md', verification: 'exact committed bytes' }],
  smallestRoute: [{ path: 'QUICKSTART.md', requirements: ['R1'], reason: 'one file' }], exclusions: [],
  processConstraints: [{ id: 'P1', source: 'Commit only quick start', expectedBehavior: 'Only requested file differs', verification: 'git show' }],
};

afterAll(() => {
  for (const child of children) child.kill();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('MCP durable release before inner retirement across API and control-plane processes', () => {
  it('persists automatic-review release before real cleanup and survives replay, delayed mirrors and reopen', async () => {
    await updateOperatorDefaults({ requireApproval: 'surface', storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
    const repo = join(dataDir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, ['config', 'user.name', 'fixture']);git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(join(repo, 'README.md'), 'fixture\n');git(repo, ['add', 'README.md']);git(repo, ['commit', '-q', '-m', 'base']);
    await addRepo(repo);
    const packetId = 'pkt-inner-release';const missionId = 'mission-inner-release';const branch = 'inline/inner-release';
    const worktree = await getWorktreeManager(repo).create({ agentType: 'codex', taskName: packetId,
      branchName: branch, baseBranch: 'main', packetId, skipSetup: true, isolationPreference: 'git-worktree' });
    writeFileSync(join(worktree.path, 'QUICKSTART.md'), '# Quick start\nRun the app to begin.\n');
    git(worktree.path, ['add', 'QUICKSTART.md']);git(worktree.path, ['commit', '-q', '-m', 'docs: quick start [via-o8]']);
    const head = git(worktree.path, ['rev-parse', 'HEAD']);
    const lane = createLane({ repoPath: repo, worktreePath: worktree.path, branch, baseBranch: 'main',
      runtime: 'codex', packetId, sessionKey: 'codex:fixture-inner-release' });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const packet = { id: packetId, referenceLabel: 'P1', title: 'quick start', summary: 'quick start',
      workspaceTargetPath: repo, branchTarget: branch, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'queued', releaseState: 'pending', status: 'awaiting_review', review: null, lane: null,
      taskContract: contract, taskContractRequired: true, taskContractSource: 'explicit', dispatcher: { surface: 'orchestrator', id: 'fixture-auto-review' },
    } as OrchestratorPacket;
    const state = normalizeOrchestratorMissionState({ ...createEmptyOrchestratorMissionState(), missionId, repoPath: repo,
      constraints: 'owner metadata', packets: [packet, { ...packet, id: 'sibling', title: 'sibling', status: 'archived', archivedAt: '2026-01-01T00:00:00Z' }] });
    recordMission({ id: missionId, repoPath: repo, runtime: 'codex', prompt: '', summary: '', constraints: state.constraints ?? '',
      packetMeta: state.packets.map(({ id, title, referenceLabel }) => ({ id, title, referenceLabel: referenceLabel ?? id })), missionState: state, totalWaves: 1 });
    writeOrchestratorControlPlaneState(state);
    const before = join(dataDir, 'before-cleanup.json'), after = join(dataDir, 'after-cleanup'), resume = join(dataDir, 'resume'), port = join(dataDir, 'port');
    const command = resolveTsxProcess(['--eval', childScript]);
    const child = spawn(command.file, command.args, { cwd: process.cwd(), env: { ...process.env,
      NODE_OPTIONS: '--conditions=react-server', O8_TEST_INNER_RELEASE: JSON.stringify({ missionId, before, after, resume, port }) }, stdio: 'pipe' });
    children.push(child);
    let diagnostic = '';
    child.stderr.on('data', (chunk) => { diagnostic += chunk.toString(); });
    child.stdout.resume();
    await waitFor(port).catch((error) => { throw new Error(`${error}; ${diagnostic}`); });
    writeFileSync(join(dataDir, 'api-port'), readFileSync(port, 'utf8'));
    setApiBase(`http://127.0.0.1:${readFileSync(port, 'utf8')}`);
    startReviewTurn({ laneId: lane.id, threadId: 'fixture-dedicated-auto-review', backend: 'codex', surface: 'auto-review' });
    const review = tool(await handleSubmitReview({ packetId, approved: true, findings: [], reviewedHeadSha: head,
      contractCoverageEvidence: { contractVersion: 1, headSha: head,
        entries: [{ requirementId: 'R1', productionPath: 'QUICKSTART.md', verification: 'exact committed bytes' }],
        processEntries: [{ constraintId: 'P1', source: 'command', reference: 'git show HEAD changes QUICKSTART.md only' }] } }));
    expect(review).toMatchObject({ recorded: true, contractCoverage: { status: 'passed' } });
    const stale = structuredClone(owner(missionId).mission);
    const other = { ...createEmptyOrchestratorMissionState(), missionId: 'mission-other', constraints: 'other owner' };
    recordMission({ id: other.missionId, repoPath: repo, runtime: 'codex', prompt: '', summary: '',
      constraints: other.constraints, packetMeta: [], missionState: other, totalWaves: 1 });
    const otherBefore = owner(other.missionId);
    const key = 'fixture-inner-merge-key';
    const merging = handleApproveAndMerge({ packetId, expectedHeadSha: head, idempotencyKey: key });
    await waitFor(after);
    // This process is the websocket/control-plane writer while the HTTP merge
    // process is paused after actual retirement and before returning its result.
    await syncOrchestratorControlPlaneState();
    writeOrchestratorControlPlaneState(other);
    await persistMissionRegistryState(stale);
    writeFileSync(resume, 'continue');
    const result = tool(await merging);
    expect(result).toMatchObject({ merged: true, mergeSha: head });
    const beforeRetirement = JSON.parse(readFileSync(before, 'utf8'));
    expect(beforeRetirement.mission.packets[0]).toMatchObject({ releaseState: 'released', status: 'released',
      releaseStatePayload: { mergeCommit: head, headSha: head }, blockedReason: null });
    expect(getLane(lane.id)).toMatchObject({ status: 'archived', outcome: 'merged', worktreePath: null });
    expect(getLaneEvents(lane.id).filter((event) => event.verb === 'merge')).toHaveLength(1);
    expect(tool(await handleApproveAndMerge({ packetId, expectedHeadSha: head, idempotencyKey: key })))
      .toMatchObject({ merged: true, replayed: true, mergeSha: head });
    expect(tool(await handleApproveAndMerge({ packetId, expectedHeadSha: head, idempotencyKey: `${key}-duplicate` })))
      .toMatchObject({ merged: true, mergeSha: head });
    expect(getLaneEvents(lane.id).filter((event) => event.verb === 'merge')).toHaveLength(1);
    await Promise.all([persistMissionRegistryState(stale), persistMissionRegistryState({ ...stale, summary: 'delayed mirror' })]);
    closeDb();
    const persisted = owner(missionId);
    expect(persisted.mission.packets[0]).toMatchObject({ releaseState: 'released', status: 'released',
      releaseStatePayload: { mergeCommit: head, headSha: head }, taskContract: contract, blockedReason: null });
    expect(persisted.mission.packets[0].review?.reviewedHeadSha).toBe(head);
    expect(persisted.archivedAt).not.toBeNull();
    expect(persisted.mission.constraints).toBe('owner metadata');
    expect(persisted.mission.packets[1]).toMatchObject({ id: 'sibling', title: 'sibling' });
    expect(git(repo, ['rev-parse', 'main'])).toBe(head);
    expect(existsSync(worktree.path)).toBe(false);
    // A focused mission read after reopen must use the owning SQLite row.
    expect(readOrchestratorControlPlaneState().missionId).toBe(other.missionId);
    expect(owner(other.missionId)).toEqual(otherBefore);
    expect(owner(missionId).mission.packets[0].releaseState).toBe('released');
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exited;
    rmSync(port);
    const reopened = spawn(command.file, command.args, { cwd: process.cwd(), env: { ...process.env,
      NODE_OPTIONS: '--conditions=react-server', O8_TEST_INNER_RELEASE: JSON.stringify({ missionId, before, after, resume, port }) }, stdio: 'pipe' });
    children.push(reopened);
    reopened.stdout.resume(); reopened.stderr.resume();
    await waitFor(port);
    const response = await fetch(`http://127.0.0.1:${readFileSync(port, 'utf8')}/api/orchestrator/status?missionId=${missionId}`,
      { headers: { Authorization: 'Bearer fixture-inner-release-token-0123456789' } });
    expect(response.status).toBe(200);
    const api = await response.json();
    expect(api.result.packets[0]).toMatchObject({ releaseState: 'released', status: 'released',
      queueState: 'held', blockedReason: null });
    expect(readOrchestratorControlPlaneState().packets).toEqual([]);
    expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM missions').get()).toMatchObject({ n: 2 });
  }, 120_000);
});
