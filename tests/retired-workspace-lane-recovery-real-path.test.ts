import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveTsxProcess } from '@/lib/testing/tsx-process';
import type { Lane } from '@/lib/lane/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { WorkspaceReconciliationReceipt } from '@/lib/workspace/reconciler';
import type { WorkspaceRetirementAction } from '@/lib/workspace/workspace-materialization-retirement';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-retired-lane-recovery-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const {
  createLane,
  getLane,
  getLaneEvents,
  setLaneStatus,
  updateLane,
} = await import('@/lib/lane/registry');
const { addRepo } = await import('@/lib/repos/registry');
const {
  createWorkspaceSnapshot,
  getWorkspaceSnapshot,
  listWorkspaceSnapshotTransitions,
  transitionWorkspaceSnapshot,
} = await import('@/lib/worktree/snapshot-state');
const {
  beginWorkspaceMaterializationRetirement,
  finishWorkspaceMaterializationRetirement,
} = await import('@/lib/workspace/workspace-materialization-retirement');

const reconcilerChildScript = String.raw`
void (async () => {
  const dbModule = await import('./src/lib/db/index.ts');
  const db = dbModule.default ?? dbModule;
  const imported = await import('./src/lib/workspace/reconciler.ts');
  const { reconcileInterruptedWorkspaces } = imported.default ?? imported;
  const result = await reconcileInterruptedWorkspaces();
  const { writeSync } = await import('node:fs');
  writeSync(1, 'O8_RECONCILER_RESULT ' + JSON.stringify(result) + '\n');
  db.closeDb();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const managedChildren = new Set<ManagedChild>();

class ManagedChild {
  stdout = '';
  stderr = '';
  private spawnError: Error | null = null;
  private exited = false;

  private readonly closed: Promise<ChildExit>;

  constructor(readonly label: string, private readonly child: ChildProcess) {
    child.stdout?.on('data', (chunk: Buffer) => { this.stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { this.stderr += chunk.toString(); });
    this.closed = new Promise<ChildExit>((resolve) => {
      child.once('close', (code, signal) => {
        this.exited = true;
        resolve({ code, signal });
      });
      child.once('error', (error) => {
        this.spawnError = error instanceof Error ? error : new Error(String(error));
        this.exited = true;
        resolve({ code: null, signal: null });
      });
    });
    managedChildren.add(this);
    child.once('close', () => managedChildren.delete(this));
    child.once('error', () => managedChildren.delete(this));
  }

  async wait(timeoutMs: number): Promise<ChildExit> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const exit = await Promise.race([
        this.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            `${this.label} exceeded ${timeoutMs}ms: ${this.stdout}${this.stderr}`,
          )), timeoutMs);
        }),
      ]);
      if (this.spawnError) {
        throw new Error(`${this.label} failed to spawn: ${this.spawnError.message}`);
      }
      return exit;
    } catch (error) {
      this.kill();
      await this.closed.catch(() => {});
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  output(): string {
    return this.stdout + this.stderr;
  }

  kill(): void {
    if (!this.exited && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
    }
  }
}

function spawnManagedChild(label: string, file: string, args: string[]): ManagedChild {
  const inheritedNodeOptions = process.env.NODE_OPTIONS?.trim();
  return new ManagedChild(label, spawn(file, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      O8_DATA_DIR: dataDir,
      CORTEX_IDE_DATA_DIR: dataDir,
      NODE_OPTIONS: [inheritedNodeOptions, '--conditions=react-server'].filter(Boolean).join(' '),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

async function runStartupReconciler(): Promise<WorkspaceReconciliationReceipt[]> {
  const command = resolveTsxProcess(['--eval', reconcilerChildScript]);
  const child = spawnManagedChild('startup reconciler', command.file, command.args);
  const exit = await child.wait(60_000);
  expect(exit.code, `reconciler child failed: ${child.output()}`).toBe(0);
  const marker = 'O8_RECONCILER_RESULT ';
  const line = child.stdout.split('\n').find((entry) => entry.startsWith(marker));
  expect(line, `reconciler child printed no receipt line: ${child.output()}`).toBeDefined();
  return JSON.parse(line!.slice(marker.length)) as WorkspaceReconciliationReceipt[];
}

const repoPath = path.join(dataDir, 'repo');
let repo: RepoRegistryEntry;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fakeSha(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

interface RetiredFixture {
  packetId: string;
  laneId: string;
  workspacePath: string;
  action: WorkspaceRetirementAction;
  laneStatus: Lane['status'];
}

const ARCHIVE_ABORT_PREFIX = 'O8_TEST_ARCHIVE_ABORT';

function triggerNameFor(laneId: string): string {
  return `reject_archive_${laneId.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function rejectLaneArchive(laneId: string): void {
  getSqlite().exec(`
    CREATE TEMPORARY TRIGGER ${triggerNameFor(laneId)}
    BEFORE UPDATE ON lanes
    WHEN NEW.status = 'archived' AND OLD.id = '${laneId}'
    BEGIN
      SELECT RAISE(ABORT, '${ARCHIVE_ABORT_PREFIX}:${laneId}');
    END;
  `);
}

function allowLaneArchive(laneId: string): void {
  getSqlite().exec(`DROP TRIGGER IF EXISTS ${triggerNameFor(laneId)}`);
}

async function crashRealRetirementBeforeArchive(fixture: RetiredFixture): Promise<void> {
  rejectLaneArchive(fixture.laneId);
  try {
    await expect(finishWorkspaceMaterializationRetirement(fixture.workspacePath, fixture.action))
      .rejects.toThrow(`${ARCHIVE_ABORT_PREFIX}:${fixture.laneId}`);
  } finally {
    allowLaneArchive(fixture.laneId);
  }
  expect(getWorkspaceSnapshot(repo.id, fixture.packetId)?.state).toBe('retired');
  expect(getLane(fixture.laneId)).toMatchObject({ status: fixture.laneStatus, outcome: null });
}

interface PersistedRetirementState {
  snapshot: unknown;
  transitions: unknown;
}

interface PersistedLaneState {
  lane: unknown;
  events: unknown;
}

function persistedRetirementState(packetId: string): PersistedRetirementState {
  const snapshot = getWorkspaceSnapshot(repo.id, packetId);
  if (!snapshot) throw new Error(`Missing persisted snapshot for ${packetId}.`);
  return {
    snapshot: JSON.parse(JSON.stringify(snapshot)),
    transitions: JSON.parse(JSON.stringify(listWorkspaceSnapshotTransitions(repo.id, packetId))),
  };
}

function persistedLaneState(laneId: string): PersistedLaneState {
  const lane = getLane(laneId);
  if (!lane) throw new Error(`Missing persisted lane ${laneId}.`);
  return {
    lane: JSON.parse(JSON.stringify(lane)),
    events: JSON.parse(JSON.stringify(getLaneEvents(laneId, 200))),
  };
}

function createRetiredSnapshotFixture(
  packetId: string,
  action: WorkspaceRetirementAction,
  laneStatus: Lane['status'],
): RetiredFixture {
  const sessionKey = `test-owned:${packetId}`;
  const workspacePath = path.join(dataDir, 'retire-workspaces', packetId);
  const branch = `inline/${packetId}`;
  const lane = createLane({
    repoPath: repo.localPath,
    branch,
    baseBranch: 'main',
    runtime: 'opencode',
    packetId,
    ownership: 'managed',
    sessionKey,
    worktreePath: workspacePath,
  });
  setLaneStatus(lane.id, laneStatus, 'system', 'retire-recovery-fixture');
  createWorkspaceSnapshot({
    repositoryUuid: repo.id,
    packetId,
    laneId: lane.id,
    originalPath: path.resolve(workspacePath),
    branch,
    baseCommit: fakeSha(`base:${packetId}`),
    headCommit: fakeSha(`head:${packetId}`),
    treeSha: fakeSha(`tree:${packetId}`),
    recoveryRef: `refs/o8/recovery/${repo.id}/${packetId}`,
    diffFingerprint: `fp:${packetId}`,
    sessionIdentities: [{ kind: 'owned-session', identity: sessionKey }],
    creationId: `retire:${action}:create`,
    receipt: { terminalBootstrap: true, terminalAction: action },
  });
  beginWorkspaceMaterializationRetirement(workspacePath, action);
  return { packetId, laneId: lane.id, workspacePath, action, laneStatus };
}

function persistHistoricalRetiredTransition(fixture: RetiredFixture): void {
  const snapshot = getWorkspaceSnapshot(repo.id, fixture.packetId);
  if (!snapshot || snapshot.state !== 'retiring') {
    throw new Error(`Fixture ${fixture.packetId} is not retiring: ${snapshot?.state ?? 'missing'}.`);
  }
  const result = transitionWorkspaceSnapshot({
    repositoryUuid: snapshot.repositoryUuid,
    packetId: snapshot.packetId,
    transitionId: `retire:${snapshot.snapshotGeneration}:${fixture.action}:finish:${snapshot.version}`,
    expectedState: 'retiring',
    expectedVersion: snapshot.version,
    expectedGeneration: snapshot.snapshotGeneration,
    toState: 'retired',
    receipt: { terminalAction: fixture.action, laneId: snapshot.laneId },
  });
  if (result.status !== 'applied') {
    throw new Error(`Historical retired transition for ${fixture.packetId} failed: ${result.status}.`);
  }
}

let mergeCrashPacket: RetiredFixture;
let discardCrashPacket: RetiredFixture;
let reboundMergePacket: RetiredFixture;
let cleanupPacket: RetiredFixture;
let heldRetirementPacket: RetiredFixture;
let unrelatedLane: Lane;
let mergeStateBeforeRecovery: PersistedRetirementState;
let discardStateBeforeRecovery: PersistedRetirementState;

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, '-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test',
    'commit', '--allow-empty', '-qm', 'base');
  repo = await addRepo(repoPath);

  mergeCrashPacket = createRetiredSnapshotFixture('packet-retire-recovery-merge', 'merge', 'merging');
  await crashRealRetirementBeforeArchive(mergeCrashPacket);

  discardCrashPacket = createRetiredSnapshotFixture('packet-retire-recovery-discard', 'discard', 'reviewing');
  await crashRealRetirementBeforeArchive(discardCrashPacket);

  reboundMergePacket = createRetiredSnapshotFixture('packet-retire-recovery-rebound', 'merge', 'merging');
  persistHistoricalRetiredTransition(reboundMergePacket);
  updateLane(reboundMergePacket.laneId, { packetId: 'packet-retire-recovery-stolen' }, 'system', {
    reason: 'lane rebound to another packet after the retirement receipt',
  });

  cleanupPacket = createRetiredSnapshotFixture('packet-retire-recovery-cleanup', 'cleanup', 'reviewing');
  await finishWorkspaceMaterializationRetirement(cleanupPacket.workspacePath, 'cleanup');

  heldRetirementPacket = createRetiredSnapshotFixture('packet-retire-recovery-held', 'merge', 'reviewing');
  mkdirSync(heldRetirementPacket.workspacePath, { recursive: true });
  writeFileSync(path.join(heldRetirementPacket.workspacePath, 'held-checkout.txt'), 'still here');

  unrelatedLane = createLane({
    repoPath: repo.localPath,
    branch: 'inline/packet-retire-recovery-unrelated',
    baseBranch: 'main',
    runtime: 'opencode',
    packetId: 'packet-retire-recovery-unrelated',
    ownership: 'managed',
    sessionKey: 'test-owned:packet-retire-recovery-unrelated',
    worktreePath: path.join(dataDir, 'retire-workspaces', 'packet-retire-recovery-unrelated'),
  });
  setLaneStatus(unrelatedLane.id, 'running', 'system', 'retire-recovery-fixture');

  mergeStateBeforeRecovery = persistedRetirementState(mergeCrashPacket.packetId);
  discardStateBeforeRecovery = persistedRetirementState(discardCrashPacket.packetId);
}, 60_000);

afterAll(() => {
  for (const child of managedChildren) child.kill();
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('retired workspace lane recovery through the real startup reconciler', () => {
  it('rejects archival after the real finish committed the retired transition, lane still merging', () => {
    const mergeSnapshot = getWorkspaceSnapshot(repo.id, mergeCrashPacket.packetId);
    expect(mergeSnapshot?.state).toBe('retired');
    const mergeTransitions = listWorkspaceSnapshotTransitions(repo.id, mergeCrashPacket.packetId);
    expect(mergeTransitions.at(-1)).toMatchObject({
      toState: 'retired',
      transitionId: expect.stringContaining(':finish:'),
    });
    const mergeLane = getLane(mergeCrashPacket.laneId);
    expect(mergeLane).toMatchObject({ status: 'merging', outcome: null });

    expect(getWorkspaceSnapshot(repo.id, discardCrashPacket.packetId)?.state).toBe('retired');
    expect(getLane(discardCrashPacket.laneId)).toMatchObject({ status: 'reviewing', outcome: null });

    expect(getWorkspaceSnapshot(repo.id, reboundMergePacket.packetId)?.state).toBe('retired');
    expect(getLane(reboundMergePacket.laneId)).toMatchObject({
      status: 'merging',
      packetId: 'packet-retire-recovery-stolen',
    });

    expect(getWorkspaceSnapshot(repo.id, cleanupPacket.packetId)?.state).toBe('retired');
    expect(getLane(cleanupPacket.laneId)).toMatchObject({ status: 'reviewing', outcome: null });

    expect(getWorkspaceSnapshot(repo.id, heldRetirementPacket.packetId)?.state).toBe('retiring');
    expect(existsSync(path.join(heldRetirementPacket.workspacePath, 'held-checkout.txt'))).toBe(true);
  });

  it.each([
    ['failed', 'discard', 'discarded'],
    ['completed', 'merge', 'merged'],
  ] as const)('archives a %s lane through the real explicit terminal finish', async (status, action, outcome) => {
    const fixture = createRetiredSnapshotFixture(`packet-retire-recovery-${status}-lane`, action, status);
    await finishWorkspaceMaterializationRetirement(fixture.workspacePath, fixture.action);
    expect(getWorkspaceSnapshot(repo.id, fixture.packetId)?.state).toBe('retired');
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'archived', outcome });
  });

  it('skips settlement when the lane rebinds while startup lookups are pending', async () => {
    const { reconcileRetiredWorkspaceLane } = await import('@/lib/workspace/reconciler');
    const { listRepos } = await import('@/lib/repos/registry');
    const fixture = createRetiredSnapshotFixture('packet-retire-recovery-late-rebind', 'merge', 'merging');
    await crashRealRetirementBeforeArchive(fixture);
    const snapshot = getWorkspaceSnapshot(repo.id, fixture.packetId);
    if (!snapshot) throw new Error('Missing late-rebind fixture snapshot.');
    const reboundRepoPath = path.join(dataDir, 'rebound-repository');
    const receipt = await reconcileRetiredWorkspaceLane(snapshot, {
      listRepos: async () => {
        getSqlite().prepare('UPDATE lanes SET repo_path = ? WHERE id = ?')
          .run(reboundRepoPath, fixture.laneId);
        return listRepos();
      },
    });
    expect(receipt).toMatchObject({
      packetId: fixture.packetId,
      fromState: 'retired',
      toState: 'retired',
      disposition: 'unchanged',
    });
    expect(getLane(fixture.laneId)).toMatchObject({
      status: 'merging',
      packetId: fixture.packetId,
      repoPath: reboundRepoPath,
      outcome: null,
    });
    expect(getWorkspaceSnapshot(repo.id, fixture.packetId)?.state).toBe('retired');
  });

  it('settles a confirmed retired merge to its terminal outcome after restart', async () => {
    closeDb();
    const receipts = await runStartupReconciler();

    expect(receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        packetId: mergeCrashPacket.packetId,
        fromState: 'retired',
        toState: 'retired',
        disposition: 'reconciled',
      }),
      expect.objectContaining({
        packetId: discardCrashPacket.packetId,
        fromState: 'retired',
        toState: 'retired',
        disposition: 'reconciled',
      }),
    ]));

    const mergeLane = getLane(mergeCrashPacket.laneId);
    expect(mergeLane).toMatchObject({ status: 'archived', outcome: 'merged' });
    expect(mergeLane?.outcomeNote).toContain('Merged');

    const discardLane = getLane(discardCrashPacket.laneId);
    expect(discardLane).toMatchObject({ status: 'archived', outcome: 'discarded' });
    expect(discardLane?.outcome).not.toBe('merged');

    expect(getLane(reboundMergePacket.laneId)).toMatchObject({
      status: 'merging',
      packetId: 'packet-retire-recovery-stolen',
      outcome: null,
    });

    expect(getLane(cleanupPacket.laneId)).toMatchObject({ status: 'reviewing', outcome: null });

    expect(getWorkspaceSnapshot(repo.id, heldRetirementPacket.packetId)?.state).toBe('retiring');
    expect(getLane(heldRetirementPacket.laneId)).toMatchObject({ status: 'reviewing', outcome: null });
    expect(existsSync(path.join(heldRetirementPacket.workspacePath, 'held-checkout.txt'))).toBe(true);

    expect(getLane(unrelatedLane.id)).toMatchObject({ status: 'running', outcome: null });

    expect(persistedRetirementState(mergeCrashPacket.packetId)).toEqual(mergeStateBeforeRecovery);
    expect(persistedRetirementState(discardCrashPacket.packetId)).toEqual(discardStateBeforeRecovery);
    expect(getWorkspaceSnapshot(repo.id, mergeCrashPacket.packetId)?.state).toBe('retired');
    expect(existsSync(mergeCrashPacket.workspacePath)).toBe(false);
  }, 60_000);

  it('is idempotent on a second restart and repeats no workspace deletion', async () => {
    const mergeLaneBefore = persistedLaneState(mergeCrashPacket.laneId);
    const discardLaneBefore = persistedLaneState(discardCrashPacket.laneId);
    const mergeStateBefore = persistedRetirementState(mergeCrashPacket.packetId);
    const discardStateBefore = persistedRetirementState(discardCrashPacket.packetId);
    mkdirSync(mergeCrashPacket.workspacePath, { recursive: true });
    writeFileSync(path.join(mergeCrashPacket.workspacePath, 'sentinel.txt'), 'occupied by an unrelated process');

    closeDb();
    await runStartupReconciler();

    expect(existsSync(path.join(mergeCrashPacket.workspacePath, 'sentinel.txt'))).toBe(true);
    expect(persistedLaneState(mergeCrashPacket.laneId)).toEqual(mergeLaneBefore);
    expect(persistedLaneState(discardCrashPacket.laneId)).toEqual(discardLaneBefore);
    expect(persistedRetirementState(mergeCrashPacket.packetId)).toEqual(mergeStateBefore);
    expect(persistedRetirementState(discardCrashPacket.packetId)).toEqual(discardStateBefore);
    expect(getLane(mergeCrashPacket.laneId)).toMatchObject({ status: 'archived', outcome: 'merged' });

    expect(getLane(heldRetirementPacket.laneId)).toMatchObject({ status: 'reviewing', outcome: null });
    expect(existsSync(path.join(heldRetirementPacket.workspacePath, 'held-checkout.txt'))).toBe(true);
  }, 60_000);

  it('refuses a mismatched terminal action against persisted retirement truth', async () => {
    const discardLaneBefore = persistedLaneState(discardCrashPacket.laneId);
    await expect(finishWorkspaceMaterializationRetirement(discardCrashPacket.workspacePath, 'merge'))
      .rejects.toThrow('no matching durable action receipt');
    expect(persistedLaneState(discardCrashPacket.laneId)).toEqual(discardLaneBefore);
  });
});
