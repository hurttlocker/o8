import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';
import type { ProcessQuiescenceReceipt } from '@/lib/workspace/process-quiescence';

const observation = vi.hoisted(() => ({ value: null as ProcessQuiescenceReceipt | null }));
vi.mock('@/lib/workspace/process-probes', () => ({
  probeOwnedSessionProcessQuiescence: async () => observation.value,
}));

// The serial integration gate owns this fresh sweep parent and its teardown.
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-retirement-refusal-')));
const dataDir = path.join(root, 'data');
const token = 'retirement-refusal-operator-fixture';
mkdirSync(dataDir);
writeFileSync(path.join(dataDir, 'ws-token'), token);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(root, 'unused-sessions');

const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
const { addRepo } = await import('@/lib/repos/registry');
const { WorktreeManager } = await import('@/lib/worktree/manager');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { registerOwnedSessionLifecycleHandler } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
const { acquireWorkspaceRetentionHold, getWorkspaceRetentionHold } = await import('@/lib/workspace/retention-holds');
const eventsRoute = await import('@/app/api/lanes/[id]/events/route');
const readbackReceipts: unknown[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(label: string) {
  const repoPath = path.join(root, label);
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repoPath, 'checkpoint.md'), 'Useful preserved checkpoint\n');
  git(repoPath, 'add', 'checkpoint.md');
  git(repoPath, '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'checkpoint');
  const repo = await addRepo(repoPath);
  const packetId = 'refusal-' + label;
  const id = 'packet-' + packetId;
  const workspacePath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, id);
  mkdirSync(path.dirname(workspacePath), { recursive: true });
  const branch = 'codex/' + label;
  git(repoPath, 'worktree', 'add', '-qb', branch, workspacePath, 'main');
  const identity = await captureWorktreeMaterializationIdentity(workspacePath);
  const parentIdentity = await captureWorktreeMaterializationIdentity(path.dirname(workspacePath));
  const surfaceId = 'refusal-fixture:' + label;
  registerOwnedSessionLifecycleHandler({
    runtimeId: 'refusal-fixture', surfaceIdPrefix: surfaceId, commandLabel: 'refusal-fixture',
    resolveRoot: () => root, sessionState: async () => 'active',
    archiveSession: async () => ({ archived: false, note: 'unused' }),
    rebindWorkspace: async () => ({ status: 'missing', receipt: null, note: 'unused' }),
    getWorkspaceBinding: async () => ({
      surfaceId, runtimeId: 'refusal-fixture', sessionState: 'active', activeRun: null,
      retainedRuns: [], retainedRunsComplete: true, retainedRunTotal: 0,
      binding: { logicalWorkspaceId: 'packet:' + packetId, repositoryUuid: repo.id,
        packetId, cwd: workspacePath, version: 1, verifiedAt: '2026-10-13T00:00:00.000Z' },
    }),
  });
  await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(id, {
    id, agentType: 'codex', sessionKey: surfaceId, baseBranch: 'main', createdAt: Date.now(),
    claudeManaged: false, taskName: label, branchName: branch, status: 'ready', isolationKind: 'git-worktree',
    materializationIdentity: identity, materializationParentIdentity: parentIdentity,
  }));
  const lane = createLane({ repoPath, worktreePath: workspacePath, branch, baseBranch: 'main',
    runtime: 'codex', packetId, sessionKey: surfaceId, ownership: 'managed' });
  return { repo, id, packetId, workspacePath, identity, lane, manager: new WorktreeManager(repoPath) };
}

function refusal(state: 'unknown' | 'live', pidIdentity: 'unknown' | 'matched' | 'reused' = 'unknown'): ProcessQuiescenceReceipt {
  return { state, checkedAt: '2026-10-13T01:02:03.004Z',
    identity: { ownership: 'owned', pidIdentity, expectedCommandIdentity: 'SECRET_COMMAND /unrelated/private' },
    probes: [{ primitive: 'filesystem_users', state,
      detail: state === 'live' ? 'Processes still have a cwd under the workspace.'
        : 'Machine cwd snapshot failed: permission denied SECRET_ENV=secret /unrelated/private' }],
    reasons: ['SECRET_ENV=secret /unrelated/private'],
  };
}

async function readback(laneId: string, authenticated = true) {
  const response = await eventsRoute.GET(new NextRequest('http://127.0.0.1/api/lanes/' + laneId + '/events?limit=100', {
    headers: authenticated ? { authorization: 'Bearer ' + token } : {},
  }), { params: Promise.resolve({ id: laneId }) });
  return { status: response.status, body: await response.json() };
}

afterAll(() => {
  closeDb();
  // An explicitly supplied verification artifact survives the gate's owned
  // fixture sweep; ordinary CI has no external receipt destination.
  const destination = process.env.O8_RETIREMENT_REFUSAL_TEST_RECEIPT;
  if (destination) writeFileSync(destination, JSON.stringify({
    proofKind: 'controlled-real-entry-regression', genuineNativeCycles: 0, readbackReceipts,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
});

it.each([
  ['unknown', 'unknown'], ['live', 'matched'], ['unknown', 'reused'],
] as const)('public cleanup preserves %s/%s observation and exact source through authenticated event readback', async (state, pidIdentity) => {
  const owner = await fixture(state + '-' + pidIdentity);
  const before = statSync(owner.workspacePath);
  observation.value = refusal(state, pidIdentity);
  expect(await owner.manager.cleanup(owner.id, { force: true, overrideLiveGuard: true })).toBe(false);
  const original = getLaneEvents(owner.lane.id, 100).filter((event) => event.payload.phase === 'retirement_process_refused');
  expect(original).toHaveLength(1);
  const payload = original[0]!.payload;
  expect(payload).toMatchObject({ checkedAt: '2026-10-13T01:02:03.004Z', state, pidIdentity });
  expect(payload.failed).toContainEqual(['filesystem_users', state, state === 'live' ? 'owned_process_live' : 'permission_denied']);
  expect(JSON.stringify(payload)).toContain('filesystem_users');
  expect(JSON.stringify(payload)).not.toMatch(/SECRET|unrelated|private|commandIdentity|stderr|expectedPid/);
  expect(JSON.stringify(payload).length).toBeLessThanOrEqual(1000);
  expect(getWorkspaceRetentionHold(owner.workspacePath, owner.identity)).toBeNull();
  const api = await readback(owner.lane.id);
  expect(api.status).toBe(200);
  expect(api.body.events.some((event: { payload: unknown }) => JSON.stringify(event.payload) === JSON.stringify(payload))).toBe(true);
  expect((await readback(owner.lane.id, false)).status).toBe(401);
  console.info('[retirement-refusal-readback]', JSON.stringify({ authenticatedStatus: api.status,
    unauthenticatedStatus: 401, payloadCharacters: JSON.stringify(payload).length, payload }));
  observation.value.checkedAt = '2026-10-13T02:00:00.000Z';
  for (let index = 0; index < 3; index += 1) {
    expect(await owner.manager.cleanup(owner.id, { force: true, overrideLiveGuard: true })).toBe(false);
  }
  expect(getLaneEvents(owner.lane.id, 100).filter((event) => event.payload.phase === 'retirement_process_refused')).toEqual(original);
  expect(statSync(owner.workspacePath).ino).toBe(before.ino);
  expect(readFileSync(path.join(owner.workspacePath, 'checkpoint.md'), 'utf8')).toBe('Useful preserved checkpoint\n');
  observation.value = { ...refusal('unknown'), state: 'quiescent', identity: { ownership: 'owned', pidIdentity: 'not_applicable' },
    probes: [], reasons: [], checkedAt: '2026-10-13T03:00:00.000Z' };
  // Exercise a later clear probe through the same public manager entry; a
  // separate controlled preservation refusal prevents this fixture's deletion.
  const preservation = vi.fn(async () => 'skip' as const);
  Object.defineProperty(owner.manager, 'preserveUncommittedWork', { value: preservation });
  expect(await owner.manager.cleanup(owner.id, { force: true, overrideLiveGuard: true })).toBe(false);
  expect(preservation).toHaveBeenCalledOnce();
  expect(getLaneEvents(owner.lane.id, 100).filter((event) => event.payload.phase === 'retirement_process_refused')).toEqual(original);
  const hold = acquireWorkspaceRetentionHold({ repositoryPath: owner.repo.localPath, repositoryUuid: owner.repo.id,
    worktreeId: owner.id, packetId: owner.packetId, laneId: owner.lane.id, identity: owner.identity,
    holdId: 'preserve-' + owner.id, reason: 'Existing exact source hold' });
  expect(await owner.manager.cleanup(owner.id, { force: true, overrideLiveGuard: true })).toBe(false);
  expect(getWorkspaceRetentionHold(owner.workspacePath, owner.identity)).toEqual(hold);
  expect(getLaneEvents(owner.lane.id, 100).filter((event) => event.payload.phase === 'retirement_process_refused')).toEqual(original);
  expect(existsSync(owner.workspacePath)).toBe(true);
  readbackReceipts.push({ state, pidIdentity, authenticatedStatus: api.status, unauthenticatedStatus: 401,
    authenticatedEvents: api.body.events, originalStoredPayload: payload,
    originalTimestampRetainedAfterLaterClear: true, repeatedObservationsDeduplicated: true,
    exactSourceInodeBefore: before.ino, exactSourceInodeAfter: statSync(owner.workspacePath).ino,
    existingHoldUnchanged: getWorkspaceRetentionHold(owner.workspacePath, owner.identity),
    payloadCharacters: JSON.stringify(payload).length, rawDiagnosticMaterialStored: false });
}, 60_000);

it('preserves every failed dimension within the packet-info cap without raw diagnostic material', async () => {
  const owner = await fixture('all-dimensions');
  observation.value = { ...refusal('unknown'), probes: [
    'pid', 'process_group', 'descendants', 'owned_marker', 'tmux', 'runtime', 'retained_run_ledger', 'filesystem_users',
  ].map((primitive) => ({ primitive: primitive as ProcessQuiescenceReceipt['probes'][number]['primitive'],
    state: 'unknown', detail: 'probe_exit_127;descendants_unavailable;SECRET_ENV=secret /unrelated/private' })) };
  expect(await owner.manager.cleanup(owner.id, { force: true, overrideLiveGuard: true })).toBe(false);
  const events = getLaneEvents(owner.lane.id, 100).filter((event) => event.payload.phase === 'retirement_process_refused');
  expect(events).toHaveLength(1);
  expect(events[0]!.payload.failed).toHaveLength(8);
  expect(JSON.stringify(events[0]!.payload).length).toBeLessThanOrEqual(1000);
  expect(JSON.stringify(events[0]!.payload)).not.toMatch(/SECRET|private|unrelated/);
  console.info('[retirement-refusal-size]', JSON.stringify({ characters: JSON.stringify(events[0]!.payload).length,
    failedDimensions: 8, rawDiagnosticMaterialStored: false }));
  readbackReceipts.push({ proof: 'all-failed-dimensions', payload: events[0]!.payload,
    payloadCharacters: JSON.stringify(events[0]!.payload).length, rawDiagnosticMaterialStored: false });
}, 60_000);

it('bounds distinct append-only observations without altering source or adding a hold', async () => {
  const owner = await fixture('history-bound');
  const before = statSync(owner.workspacePath);
  for (let index = 0; index < 10; index += 1) {
    observation.value = { ...refusal('unknown'), probes: [
      { primitive: 'process_group', state: 'unknown', detail: 'Process-group probe failed with exit ' + (index + 2) + '.' },
    ] };
    expect(await owner.manager.cleanup(owner.id, { force: true, overrideLiveGuard: true })).toBe(false);
  }
  const events = getLaneEvents(owner.lane.id, 100).filter((event) => event.payload.phase === 'retirement_process_refused');
  expect(events).toHaveLength(8);
  expect(events.every((event) => JSON.stringify(event.payload).length <= 1000)).toBe(true);
  expect(statSync(owner.workspacePath).ino).toBe(before.ino);
  expect(getWorkspaceRetentionHold(owner.workspacePath, owner.identity)).toBeNull();
}, 60_000);

it('still refuses before any source write when diagnostic persistence fails', async () => {
  const owner = await fixture('persistence-failure');
  observation.value = refusal('unknown');
  getSqlite().exec(`CREATE TRIGGER refuse_diagnostic BEFORE INSERT ON lane_events
    WHEN NEW.payload_json LIKE '%retirement_process_refused%'
    BEGIN SELECT RAISE(ABORT, 'SECRET database detail'); END;`);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await owner.manager.cleanup(owner.id, { force: true, overrideLiveGuard: true })).toBe(false);
    expect(error.mock.calls.flat().join(' ')).toContain('diagnostic persistence failed');
    expect(error.mock.calls.flat().join(' ')).not.toContain('SECRET database detail');
    expect(readFileSync(path.join(owner.workspacePath, 'checkpoint.md'), 'utf8')).toBe('Useful preserved checkpoint\n');
  } finally {
    getSqlite().exec('DROP TRIGGER refuse_diagnostic');
    error.mockRestore();
  }
}, 60_000);
